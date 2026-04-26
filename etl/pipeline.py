#!/usr/bin/env python3
"""
India Geo SaaS - ETL Pipeline
Processes Census 2011 MDDS village-level data across all states.
Handles dirty data: duplicates, trailing spaces, inconsistent codes,
aggregate rows, and cross-state name normalization.
"""

import os, sys, re, hashlib, logging
from pathlib import Path
from typing import Optional
import pandas as pd
import xlrd
from unidecode import unidecode
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

# ─── Configuration ──────────────────────────────────────────────────────────
SOURCE_FILES = {
    "Rdir_2011_ARUNACHAL_PRADESH__SIKKIM__NAGALAND__MIZORAM__TRIPURA.xls": "xls",
    "Rdir_2011_DADRA___NAGAR_HAVELI__MAHARASHTRA__ANDHRA_PRADESH__KARNATAKA__GOA.xls": "xls",
    "Rdir_2011_HIMACHAL_PRADESH__PUNJAB__RAJASTHAN__ASSAM.xls": "xls",
    "Rdir_2011_LAKSHADWEEP__KERALA__TAMIL_NADU__ANDAMAN___NICOBAR_ISLANDS__PUDUCHERRY.xls": "xls",
    "Rdir_2011_ODISHA__MADHYA_PRADESH__GUJRAT__CHHATTISGARH__DAMAN___DIU.xls": "xls",
    "Rdir_2011_UTTAR_PRADESH__BIHAR__MEGHALAYA__WEST_BENGAL__JHARKHAND.xlsx": "xlsx",
}

# ─── Normalization ───────────────────────────────────────────────────────────
def normalize_text(s: str) -> str:
    """Lowercase, transliterate unicode, strip, collapse spaces."""
    if not s or pd.isna(s):
        return ""
    s = str(s).strip()
    s = unidecode(s)
    s = re.sub(r'\s+', ' ', s)
    return s.lower()

def clean_name(s: str) -> str:
    """Title-case, strip, collapse internal spaces."""
    if not s or pd.isna(s):
        return ""
    return re.sub(r'\s+', ' ', str(s).strip())

def normalize_code(code) -> str:
    """Normalize numeric or string code to zero-padded string."""
    try:
        return str(int(float(str(code).strip()))).zfill(6)
    except (ValueError, TypeError):
        return str(code).strip().zfill(6)

def is_aggregate_row(plcn_code: str) -> bool:
    """Rows with PLCN code 000000 are state/district/sub-district aggregate rows."""
    return plcn_code == "000000"

# ─── File Reader ─────────────────────────────────────────────────────────────
def read_sheet(filepath: str, sheet_name: str, fmt: str) -> pd.DataFrame:
    """Read a sheet from XLS or XLSX file."""
    if fmt == "xls":
        wb = xlrd.open_workbook(filepath)
        sh = wb.sheet_by_name(sheet_name)
        rows = [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
        df = pd.DataFrame(rows[1:], columns=rows[0])
    else:
        df = pd.read_excel(filepath, sheet_name=sheet_name, dtype=str)
    return df

def get_sheets(filepath: str, fmt: str) -> list:
    if fmt == "xls":
        return xlrd.open_workbook(filepath).sheet_names()
    else:
        return pd.ExcelFile(filepath).sheet_names

# ─── Data Extraction ──────────────────────────────────────────────────────────
class GeoETL:
    def __init__(self, source_dir: str):
        self.source_dir = Path(source_dir)
        self.states: dict[str, dict] = {}      # state_code → {name, normalized}
        self.districts: dict[str, dict] = {}    # state_code+dist_code → {...}
        self.sub_districts: dict[str, dict] = {}
        self.villages: list[dict] = []
        self.seen_village_keys: set = set()     # dedup key
        self.stats = {"states": 0, "districts": 0, "sub_districts": 0, "villages": 0,
                      "skipped_aggregates": 0, "deduped": 0, "dirty_fixed": 0}

    def run(self):
        for filename, fmt in SOURCE_FILES.items():
            filepath = str(self.source_dir / filename)
            if not Path(filepath).exists():
                log.warning(f"File not found: {filepath}")
                continue
            log.info(f"Processing: {filename}")
            self._process_file(filepath, fmt)

        log.info(f"ETL complete: {self.stats}")
        return self

    def _process_file(self, filepath: str, fmt: str):
        for sheet_name in get_sheets(filepath, fmt):
            log.info(f"  Sheet: {sheet_name}")
            df = read_sheet(filepath, sheet_name, fmt)
            self._process_sheet(df, sheet_name)

    def _process_sheet(self, df: pd.DataFrame, sheet_name: str):
        required_cols = {'MDDS STC', 'STATE NAME', 'MDDS DTC', 'DISTRICT NAME',
                         'MDDS Sub_DT', 'SUB-DISTRICT NAME', 'MDDS PLCN', 'Area Name'}
        if not required_cols.issubset(set(df.columns)):
            log.warning(f"    Skipping sheet with unexpected columns: {df.columns.tolist()}")
            return

        # Carry-forward state for filling blank sub-district rows
        last_subdist_code = "00000"
        last_subdist_name = ""

        for _, row in df.iterrows():
            try:
                state_code = str(int(float(str(row['MDDS STC']).strip()))).zfill(2)
            except (ValueError, TypeError):
                continue
            try:
                dist_code = str(int(float(str(row['MDDS DTC']).strip()))).zfill(3)
            except (ValueError, TypeError):
                continue

            # Sub-district: carry forward last known if blank (dirty data fix)
            raw_sd = str(row['MDDS Sub_DT']).strip()
            if raw_sd == '' or raw_sd == 'nan':
                subdist_code = last_subdist_code
                subdist_name = last_subdist_name
                self.stats['dirty_fixed'] += 1
            else:
                try:
                    subdist_code = str(int(float(raw_sd))).zfill(5)
                    subdist_name = clean_name(row['SUB-DISTRICT NAME'])
                    if subdist_code != "00000":
                        last_subdist_code = subdist_code
                        last_subdist_name = subdist_name
                except (ValueError, TypeError):
                    subdist_code = last_subdist_code
                    subdist_name = last_subdist_name

            plcn_code   = normalize_code(row['MDDS PLCN'])

            state_name   = clean_name(row['STATE NAME'])
            dist_name    = clean_name(row['DISTRICT NAME'])
            area_name    = clean_name(row['Area Name'])

            # Track dirty fixes
            orig_area = str(row['Area Name'])
            if orig_area != area_name:
                self.stats['dirty_fixed'] += 1

            # ── State ─────────────────────────────────────────────────────
            if state_code not in self.states:
                self.states[state_code] = {
                    "code": state_code,
                    "name": state_name,
                    "normalized_name": normalize_text(state_name),
                }
                self.stats['states'] += 1

            # ── Aggregate row detection ────────────────────────────────────
            if is_aggregate_row(plcn_code):
                self.stats['skipped_aggregates'] += 1
                # Still capture district and sub-district from aggregate rows
                if dist_code != "000":
                    dk = f"{state_code}_{dist_code}"
                    if dk not in self.districts:
                        self.districts[dk] = {
                            "state_code": state_code, "code": dist_code,
                            "name": dist_name, "normalized_name": normalize_text(dist_name),
                        }
                        self.stats['districts'] += 1
                    if subdist_code != "00000":
                        sk = f"{state_code}_{dist_code}_{subdist_code}"
                        if sk not in self.sub_districts:
                            self.sub_districts[sk] = {
                                "state_code": state_code, "district_key": dk,
                                "code": subdist_code, "name": subdist_name,
                                "normalized_name": normalize_text(subdist_name),
                            }
                            self.stats['sub_districts'] += 1
                continue

            # ── District ──────────────────────────────────────────────────
            dk = f"{state_code}_{dist_code}"
            if dk not in self.districts:
                self.districts[dk] = {
                    "state_code": state_code, "code": dist_code,
                    "name": dist_name, "normalized_name": normalize_text(dist_name),
                }
                self.stats['districts'] += 1

            # ── Sub-District ───────────────────────────────────────────────
            sk = f"{state_code}_{dist_code}_{subdist_code}"
            if sk not in self.sub_districts:
                self.sub_districts[sk] = {
                    "state_code": state_code, "district_key": dk,
                    "code": subdist_code, "name": subdist_name,
                    "normalized_name": normalize_text(subdist_name),
                }
                self.stats['sub_districts'] += 1

            # ── Village deduplication ──────────────────────────────────────
            # Primary key: PLCN code + state. Duplicate PLCNs across states are valid.
            # Duplicate PLCNs within a state = dirty data → deduplicate by composite key
            dedup_key = f"{state_code}_{plcn_code}"
            if dedup_key in self.seen_village_keys:
                self.stats['deduped'] += 1
                # Still add if area name differs (same code, different village - use composite)
                dedup_key = f"{state_code}_{plcn_code}_{normalize_text(area_name)}"
                if dedup_key in self.seen_village_keys:
                    continue
            self.seen_village_keys.add(dedup_key)

            # Full address: "Area Name (Village), Sub-District, District, State, India"
            full_address = f"{area_name}, {subdist_name}, {dist_name}, {state_name}, India"

            self.villages.append({
                "sub_district_key": sk,
                "code": plcn_code,
                "name": area_name,
                "normalized_name": normalize_text(area_name),
                "full_address": full_address,
            })
            self.stats['villages'] += 1

    # ── SQL Generation ────────────────────────────────────────────────────────
    def to_sql(self, output_path: str):
        """Generate optimized SQL seed file."""
        log.info(f"Writing SQL to {output_path}...")
        lines = [
            "-- India Geo SaaS - Generated Seed Data",
            "-- DO NOT EDIT MANUALLY",
            "BEGIN;",
            "",
            "-- States",
        ]

        state_id_map = {}
        for i, (k, s) in enumerate(self.states.items(), 1):
            state_id_map[k] = i
            name = s['name'].replace("'", "''")
            norm = s['normalized_name'].replace("'", "''")
            lines.append(f"INSERT INTO states (id, code, name, normalized_name) VALUES ({i}, '{s['code']}', '{name}', '{norm}');")

        lines += ["", "-- Districts"]
        dist_id_map = {}
        for i, (k, d) in enumerate(self.districts.items(), 1):
            dist_id_map[k] = i
            sid = state_id_map.get(d['state_code'], 0)
            name = d['name'].replace("'", "''")
            norm = d['normalized_name'].replace("'", "''")
            lines.append(f"INSERT INTO districts (id, state_id, code, name, normalized_name) VALUES ({i}, {sid}, '{d['code']}', '{name}', '{norm}');")

        lines += ["", "-- Sub-Districts"]
        subdist_id_map = {}
        for i, (k, sd) in enumerate(self.sub_districts.items(), 1):
            subdist_id_map[k] = i
            did = dist_id_map.get(sd['district_key'], 0)
            name = sd['name'].replace("'", "''")
            norm = sd['normalized_name'].replace("'", "''")
            lines.append(f"INSERT INTO sub_districts (id, district_id, code, name, normalized_name) VALUES ({i}, {did}, '{sd['code']}', '{name}', '{norm}');")

        lines += ["", "-- Villages (batched for performance)"]
        BATCH = 1000
        for b_start in range(0, len(self.villages), BATCH):
            batch = self.villages[b_start:b_start+BATCH]
            vals = []
            for i, v in enumerate(batch, b_start + 1):
                sdid = subdist_id_map.get(v['sub_district_key'], 0)
                name = v['name'].replace("'", "''")
                norm = v['normalized_name'].replace("'", "''")
                addr = v['full_address'].replace("'", "''")
                vals.append(f"({i}, {sdid}, '{v['code']}', '{name}', '{norm}', '{addr}')")
            lines.append("INSERT INTO villages (id, sub_district_id, code, name, normalized_name, full_address) VALUES")
            lines.append(",\n".join(vals) + ";")

        lines += ["", "COMMIT;"]

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        log.info(f"SQL written: {sum(1 for l in lines if l.startswith('INSERT'))} INSERT statements")
        return self


# ─── Entry Point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    source = sys.argv[1] if len(sys.argv) > 1 else "."
    output = sys.argv[2] if len(sys.argv) > 2 else "../db/seed.sql"
    etl = GeoETL(source).run()
    etl.to_sql(output)
    print(f"\n✅ ETL complete:")
    for k, v in etl.stats.items():
        print(f"   {k:20s}: {v:,}")
