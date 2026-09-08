const MANAGE_YEAR = "2026";
const MANAGE_VERSION = "第12版（2026-09-08 開発部・コンテンツくんと繋ぐ）";
const MANAGE_HEADERS = [
  "投稿予定日",
  "ステータス",
  "媒体",
  "テーマ",
  "タイトル",
  "Whimsical",
  "zoom",
  "YouTube",
  "記事",
  "補強依頼",
  "補強完了",
  "フォルダ",
  "メモ",
  "録画の状態",
  "処理ID",
] as const;
const STATUS_VALUES = ["下書き", "レビュー待ち", "日時未定", "予約済み", "公開済"];
const PLATFORM_VALUES = ["X記事", "Xポスト", "note記事", "セミナー", "有料教材", "YouTube"];

export interface ManageEnv {
  STORE: R2Bucket;
  CONTENT_OS_API_BASE?: string;
  CONTENT_OS_INTERNAL_SECRET?: string;
  CONTENT_OS_USER_ID?: string;
  CONTENT_OS_ACCOUNT_ID?: string;
}

interface ManageConfig {
  id: string;
  created: string;
}

interface SheetProperties {
  sheetId?: number;
  title?: string;
}

interface SheetRow {
  tab: string;
  rowNo: number;
  values: string[];
}

export interface ManageSyncResult {
  url: string;
  made: boolean;
  added: number;
  updated: number;
  unchanged: number;
  skippedYear: number;
  undecidableDestination: number;
  noSpace: number;
}

export interface ContentOsSyncResult {
  missingSettings: boolean;
  created: number;
  statusUpdated: number;
  unchanged: number;
  createFailed: number;
  postNotFound: number;
}

interface ContentPost {
  id: string;
  status: string;
}

function manageKey(year = MANAGE_YEAR): string {
  return `config/manage-${year}.json`;
}

function tabs(year = MANAGE_YEAR): string[] {
  return ["テンプレ", ...Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)];
}

function jstParts(msUtc: number): { year: string; month: string } {
  const d = new Date(msUtc + 9 * 60 * 60 * 1000);
  return {
    year: String(d.getUTCFullYear()),
    month: String(d.getUTCMonth() + 1).padStart(2, "0"),
  };
}

async function googleJson<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  const raw = await res.text();
  if (!res.ok) throw new Error(`管理シート：Google からの返事 ${res.status}：${raw.slice(0, 600)}`);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

async function loadConfig(env: ManageEnv, year = MANAGE_YEAR): Promise<ManageConfig | null> {
  const object = await env.STORE.get(manageKey(year));
  if (!object) return null;
  return JSON.parse(await object.text()) as ManageConfig;
}

async function sheetMetadata(token: string, id: string): Promise<SheetProperties[]> {
  const got = await googleJson<{ sheets?: { properties?: SheetProperties }[] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(sheetId,title)`,
  );
  return (got.sheets ?? []).map((sheet) => sheet.properties ?? {});
}

async function setUpTabs(token: string, id: string, properties: SheetProperties[]): Promise<void> {
  const byTitle = new Map(properties.map((property) => [property.title ?? "", property.sheetId]));
  const requests: Record<string, unknown>[] = [];

  for (const tab of tabs()) {
    const sheetId = byTitle.get(tab);
    if (sheetId === undefined) throw new Error(`管理シート：タブ ${tab} の番号が見つかりません`);
    requests.push(
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 14, endIndex: 15 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 1, endColumnIndex: 2 },
          rule: {
            condition: { type: "ONE_OF_LIST", values: STATUS_VALUES.map((userEnteredValue) => ({ userEnteredValue })) },
            strict: true,
            showCustomUi: true,
          },
        },
      },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 2, endColumnIndex: 3 },
          rule: {
            condition: { type: "ONE_OF_LIST", values: PLATFORM_VALUES.map((userEnteredValue) => ({ userEnteredValue })) },
            strict: true,
            showCustomUi: true,
          },
        },
      },
    );
    for (const column of [9, 10]) {
      requests.push({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: column, endColumnIndex: column + 1 },
          rule: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true },
        },
      });
    }
  }

  await googleJson(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  await googleJson(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: tabs().map((tab) => ({ range: `${tab}!A1:O1`, values: [[...MANAGE_HEADERS]] })),
    }),
  });
}

export async function reapplyFormats(env: ManageEnv, token: string): Promise<{ url: string; tabs: number }> {
  const config = await loadConfig(env);
  if (!config) throw new Error("管理シート：ファイルはまだありません");
  const properties = await sheetMetadata(token, config.id);
  await setUpTabs(token, config.id, properties);
  return { url: `https://docs.google.com/spreadsheets/d/${config.id}/edit`, tabs: properties.length };
}

async function ensureManageSheet(
  env: ManageEnv,
  token: string,
): Promise<{ id: string; url: string; made: boolean }> {
  const existing = await loadConfig(env);
  if (existing) {
    return { id: existing.id, url: `https://docs.google.com/spreadsheets/d/${existing.id}/edit`, made: false };
  }

  const made = await googleJson<{ spreadsheetId: string; sheets?: { properties?: SheetProperties }[] }>(
    token,
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        properties: { title: `コンテンツ管理 ${MANAGE_YEAR}` },
        sheets: tabs().map((title) => ({ properties: { title, gridProperties: { frozenRowCount: 1 } } })),
      }),
    },
  );
  if (!made.spreadsheetId) throw new Error("管理シート：作ったシートの番号が返りません");

  await env.STORE.put(manageKey(), JSON.stringify({ id: made.spreadsheetId, created: new Date().toISOString() }));
  await setUpTabs(
    token,
    made.spreadsheetId,
    (made.sheets ?? []).map((sheet) => sheet.properties ?? {}),
  );
  return {
    id: made.spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${made.spreadsheetId}/edit`,
    made: true,
  };
}

async function readSourceRows(token: string, sourceSheetId: string): Promise<string[][]> {
  const got = await googleJson<{ values?: string[][] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${sourceSheetId}/values/${encodeURIComponent("受付!A2:I500")}`,
  );
  return got.values ?? [];
}

async function readManageRows(token: string, id: string): Promise<Map<string, SheetRow>> {
  const ranges = tabs().map((tab) => `ranges=${encodeURIComponent(`${tab}!A2:O500`)}`).join("&");
  const got = await googleJson<{ valueRanges?: { range?: string; values?: string[][] }[] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?majorDimension=ROWS&${ranges}`,
  );
  const rowsById = new Map<string, SheetRow>();
  (got.valueRanges ?? []).forEach((range, tabIndex) => {
    const tab = tabs()[tabIndex];
    (range.values ?? []).forEach((values, rowIndex) => {
      const idValue = (values[14] ?? "").trim();
      if (idValue) rowsById.set(idValue, { tab, rowNo: rowIndex + 2, values });
    });
  });
  return rowsById;
}

async function readRowsByTab(token: string, id: string): Promise<Map<string, string[][]>> {
  const ranges = tabs().map((tab) => `ranges=${encodeURIComponent(`${tab}!A2:O500`)}`).join("&");
  const got = await googleJson<{ valueRanges?: { values?: string[][] }[] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?majorDimension=ROWS&${ranges}`,
  );
  const result = new Map<string, string[][]>();
  tabs().forEach((tab, index) => result.set(tab, got.valueRanges?.[index]?.values ?? []));
  return result;
}

function destination(row: string[]): { year: string; tab: string } | null {
  const recorded = (row[3] ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(recorded)) {
    return { year: recorded.slice(0, 4), tab: `${recorded.slice(0, 4)}-${recorded.slice(5, 7)}` };
  }
  const updated = Date.parse((row[8] ?? "").trim());
  if (!Number.isFinite(updated)) return null;
  const when = jstParts(updated);
  return { year: when.year, tab: `${when.year}-${when.month}` };
}

function recordingState(row: string[]): string {
  const state = (row[6] ?? "").trim();
  const error = (row[7] ?? "").trim();
  return error ? `${state}：${error}` : state;
}

async function writeCells(
  token: string,
  id: string,
  cells: { range: string; values: string[][] }[],
): Promise<void> {
  if (cells.length === 0) return;
  await googleJson(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data: cells }),
  });
}

function contentStatus(status: string): string | null {
  const statuses: Record<string, string> = {
    draft: "下書き",
    review: "レビュー待ち",
    waiting: "日時未定",
    reserved: "予約済み",
    published: "公開済",
  };
  return statuses[status] ?? null;
}

function contentOsSettings(env: ManageEnv): {
  base: string;
  secret: string;
  userId: string;
  accountId: string;
} | null {
  const base = env.CONTENT_OS_API_BASE?.trim() ?? "";
  const secret = env.CONTENT_OS_INTERNAL_SECRET?.trim() ?? "";
  const userId = env.CONTENT_OS_USER_ID?.trim() ?? "";
  const accountId = env.CONTENT_OS_ACCOUNT_ID?.trim() ?? "";
  if (!base || !secret || !userId || !accountId) return null;
  return { base: base.replace(/\/+$/, ""), secret, userId, accountId };
}

async function contentOsJson<T>(
  url: string,
  secret: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`コンテンツくんからの返事 ${res.status}：${raw.slice(0, 600)}`);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function postsFrom(body: unknown): ContentPost[] {
  const candidates: unknown[] = [body];
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    candidates.push(record.posts, record.items, record.data);
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      const data = record.data as Record<string, unknown>;
      candidates.push(data.posts, data.items);
    }
  }
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) throw new Error("コンテンツくん：投稿の一覧が返りませんでした");
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.id === undefined || typeof record.status !== "string") return [];
    return [{ id: String(record.id), status: record.status }];
  });
}

export async function syncContentOs(env: ManageEnv, token: string): Promise<ContentOsSyncResult> {
  const settings = contentOsSettings(env);
  const result: ContentOsSyncResult = {
    missingSettings: settings === null,
    created: 0,
    statusUpdated: 0,
    unchanged: 0,
    createFailed: 0,
    postNotFound: 0,
  };
  if (!settings) return result;

  const config = await loadConfig(env);
  if (!config) throw new Error("管理シート：ファイルはまだありません");
  const rowsByTab = await readRowsByTab(token, config.id);
  const writes: { range: string; values: string[][] }[] = [];
  const statusTargets: { tab: string; rowNo: number; row: string[]; postId: string | null }[] = [];

  for (const [tab, rows] of rowsByTab) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNo = index + 2;
      const date = (row[0] ?? "").trim();
      const platform = (row[2] ?? "").trim();
      const title = (row[4] ?? "").trim();
      const article = (row[8] ?? "").trim();
      if (!date || !platform || !title) continue;

      if (article) {
        const marker = article.match(/#post-([^#/?]+)$/);
        statusTargets.push({ tab, rowNo, row, postId: marker?.[1] ?? null });
        continue;
      }

      try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.slice(0, 10))) throw new Error("投稿予定日が日付ではありません");
        const made = await contentOsJson<{
          ok?: boolean;
          slot?: { id?: string | number; status?: string };
        }>(`${settings.base}/api/internal/create-slot`, settings.secret, {
          user_id: settings.userId,
          datetime: `${date.slice(0, 10)}T09:00`,
          title,
          platform: "x",
          post_type: platform,
          account_id: settings.accountId,
        });
        if (!made.ok || made.slot?.id === undefined) throw new Error("枠の番号が返りませんでした");
        const articleUrl = `${settings.base}/?account=${encodeURIComponent(settings.accountId)}#post-${made.slot.id}`;
        writes.push({ range: `${tab}!I${rowNo}`, values: [[articleUrl]] });
        const status = contentStatus(made.slot.status ?? "");
        if (status) {
          writes.push({ range: `${tab}!B${rowNo}`, values: [[status]] });
          result.statusUpdated += 1;
        }
        result.created += 1;
      } catch {
        result.createFailed += 1;
      }
    }
  }

  if (statusTargets.length > 0) {
    const listed = await contentOsJson<unknown>(
      `${settings.base}/api/internal/list-posts`,
      settings.secret,
      { user_id: settings.userId },
    );
    const posts = new Map(postsFrom(listed).map((post) => [post.id, post]));
    for (const target of statusTargets) {
      const post = target.postId ? posts.get(target.postId) : undefined;
      if (!post) {
        result.postNotFound += 1;
        continue;
      }
      const status = contentStatus(post.status);
      if (!status || (target.row[1] ?? "") === status) {
        result.unchanged += 1;
        continue;
      }
      writes.push({ range: `${target.tab}!B${target.rowNo}`, values: [[status]] });
      result.statusUpdated += 1;
    }
  }

  await writeCells(token, config.id, writes);
  return result;
}

export async function syncManageSheet(
  env: ManageEnv,
  token: string,
  sourceSheetId: string,
): Promise<ManageSyncResult> {
  const sheet = await ensureManageSheet(env, token);
  if (!sheet.made) {
    const properties = await sheetMetadata(token, sheet.id);
    const actualTabs = new Set(properties.map((property) => property.title ?? ""));
    if (tabs().some((tab) => !actualTabs.has(tab))) await setUpTabs(token, sheet.id, properties);
  }

  const sourceRows = await readSourceRows(token, sourceSheetId);
  const existing = await readManageRows(token, sheet.id);
  const rowsByTab = await readRowsByTab(token, sheet.id);
  const writes: { range: string; values: string[][] }[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedYear = 0;
  let undecidableDestination = 0;
  let noSpace = 0;

  for (const source of sourceRows) {
    const processingId = (source[0] ?? "").trim();
    if (!processingId) continue;
    const dest = destination(source);
    if (!dest) {
      undecidableDestination += 1;
      continue;
    }
    if (dest.year !== MANAGE_YEAR || !tabs().includes(dest.tab)) {
      skippedYear += 1;
      continue;
    }

    const wanted = {
      zoom: source[1] ?? "",
      youtube: source[5] ?? "",
      folder: source[4] ?? "",
      state: recordingState(source),
    };
    const found = existing.get(processingId);
    if (found) {
      const changes = [
        { column: "G", index: 6, value: wanted.zoom },
        { column: "H", index: 7, value: wanted.youtube },
        { column: "L", index: 11, value: wanted.folder },
        { column: "N", index: 13, value: wanted.state },
      ].filter(({ index, value }) => (found.values[index] ?? "") !== value);
      if (changes.length === 0) {
        unchanged += 1;
        continue;
      }
      for (const change of changes) {
        writes.push({ range: `${found.tab}!${change.column}${found.rowNo}`, values: [[change.value]] });
      }
      updated += 1;
      continue;
    }

    const tabRows = rowsByTab.get(dest.tab) ?? [];
    let rowNo = 2;
    const occupiedColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14];
    while (rowNo <= 500 && occupiedColumns.some((column) => (tabRows[rowNo - 2]?.[column] ?? "") !== "")) rowNo += 1;
    if (rowNo > 500) {
      noSpace += 1;
      continue;
    }

    writes.push(
      { range: `${dest.tab}!G${rowNo}:H${rowNo}`, values: [[wanted.zoom, wanted.youtube]] },
      { range: `${dest.tab}!L${rowNo}`, values: [[wanted.folder]] },
      { range: `${dest.tab}!N${rowNo}:O${rowNo}`, values: [[wanted.state, processingId]] },
    );
    const occupied = [...tabRows[rowNo - 2] ?? []];
    occupied[6] = wanted.zoom;
    occupied[7] = wanted.youtube;
    occupied[11] = wanted.folder;
    occupied[13] = wanted.state;
    occupied[14] = processingId;
    tabRows[rowNo - 2] = occupied;
    existing.set(processingId, { tab: dest.tab, rowNo, values: occupied });
    added += 1;
  }

  await writeCells(token, sheet.id, writes);
  return {
    url: sheet.url,
    made: sheet.made,
    added,
    updated,
    unchanged,
    skippedYear,
    undecidableDestination,
    noSpace,
  };
}

export async function manageStatus(env: ManageEnv, token: string, sourceSheetId: string): Promise<string> {
  const sourceRows = await readSourceRows(token, sourceSheetId);
  const targetIds = new Set<string>();
  for (const row of sourceRows) {
    const processingId = (row[0] ?? "").trim();
    const dest = destination(row);
    if (processingId && dest?.year === MANAGE_YEAR) targetIds.add(processingId);
  }

  const config = await loadConfig(env);
  if (!config) {
    return [
      `版：${MANAGE_VERSION}`,
      "ファイルの住所：まだ無い",
      "タブの数：0",
      `台帳の対象の行数：${targetIds.size}`,
      "管理シートに入っている処理IDの数：0",
      `まだ入っていない処理IDの数：${targetIds.size}`,
    ].join("\n");
  }

  const properties = await sheetMetadata(token, config.id);
  const managed = await readManageRows(token, config.id);
  let present = 0;
  for (const id of targetIds) if (managed.has(id)) present += 1;
  return [
    `版：${MANAGE_VERSION}`,
    `ファイルの住所：https://docs.google.com/spreadsheets/d/${config.id}/edit`,
    `タブの数：${properties.length}`,
    `台帳の対象の行数：${targetIds.size}`,
    `管理シートに入っている処理IDの数：${present}`,
    `まだ入っていない処理IDの数：${targetIds.size - present}`,
  ].join("\n");
}
