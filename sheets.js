const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

function parseSheetId(raw) {
  if (!raw) return raw;
  const m = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw.trim();
}

const SPREADSHEET_ID = parseSheetId(process.env.GOOGLE_SHEET_ID);
const SHEET_NAME = process.env.SHEET_NAME || 'Roster';

// Resolve Google service account credentials in a deployment-friendly way.
// Supports (in order): a JSON string env var, a base64-encoded JSON env var,
// a GOOGLE_SERVICE_ACCOUNT_KEY that contains JSON, or a key file path.
function resolveCredentials() {
  const jsonCandidates = [
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_CREDENTIALS_JSON,
    process.env.SERVICE_ACCOUNT_JSON,
    process.env.GCP_SERVICE_ACCOUNT_JSON,
  ];
  for (const c of jsonCandidates) {
    if (c && c.trim()) {
      const trimmed = c.trim();
      try {
        if (trimmed.startsWith('{')) return { type: 'object', value: JSON.parse(trimmed) };
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
        if (decoded.startsWith('{')) return { type: 'object', value: JSON.parse(decoded) };
      } catch (e) {
        throw new Error('Invalid Google service account JSON in environment variable: ' + e.message);
      }
    }
  }

  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  if (key.startsWith('{')) {
    try {
      return { type: 'object', value: JSON.parse(key) };
    } catch (e) {
      throw new Error('Invalid Google service account JSON in GOOGLE_SERVICE_ACCOUNT_KEY: ' + e.message);
    }
  }

  const keyFile = key && !key.startsWith('{')
    ? key
    : (process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json');

  if (fs.existsSync(keyFile)) {
    return { type: 'file', value: keyFile };
  }

  throw new Error(
    'Google service account credentials not found. ' +
    'On Railway/Heroku set GOOGLE_SERVICE_ACCOUNT_JSON to the full contents of credentials.json ' +
    '(or GOOGLE_SERVICE_ACCOUNT_KEY to a valid file path). Looked for file: ' + keyFile
  );
}
const SECTIONS_FILE = process.env.SECTIONS_FILE || './sections.json';
const HC_START_ROW = 11;
const HC_ROWS = 10;
const CMD_START_ROW = 22;
const CMD_ROWS = 16;
const SUP_START_ROW = 39;
const SUP_ROWS = 10;
const PROB_START_ROW = 50;
const PROB_ROWS = 19;

let sheetsClient = null;
let sheetIdCache = null;

function loadSections() {
  try {
    return JSON.parse(fs.readFileSync(SECTIONS_FILE, 'utf8'));
  } catch (e) {
    return [
      { title: 'High-command', roles: ['Superintendent', 'Colonel', 'Major', 'Lieutenant Colonel', 'Lt. Colonel', 'Lt Colonel', '1327114656539611218'] },
      { title: 'Command', roles: ['Captain', 'Lieutenant', '1327114656539611220'] },
      { title: 'Supervisors', roles: ['Sergeant', 'Master Sergeant', 'Senior Corporal', 'Corporal'] },
      { title: 'Probationary Troopers', roles: ['Probationary Trooper', 'Probationary Troopers'] },
    ];
  }
}

async function getClient() {
  if (sheetsClient) return sheetsClient;
  let auth;
  const resolved = resolveCredentials();
  if (resolved.type === 'object') {
    auth = new google.auth.GoogleAuth({
      credentials: resolved.value,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: resolved.value,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  return sheetsClient;
}

async function ensureSheet() {
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sh = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME);
  if (!sh) {
    const resp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
    sheetIdCache = resp.data.replies[0].addSheet.properties.sheetId;
  } else {
    sheetIdCache = sh.properties.sheetId;
  }
}

function isDiscordId(v) {
  return /^\d{15,20}$/.test(String(v || '').trim());
}

async function readExistingManual() {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = res.data.values || [];
  const map = new Map();
  for (const row of rows) {
    const id = (row[4] || '').toString().trim();
    if (isDiscordId(id)) {
      map.set(id, {
        badge: row[2] || '',
        assignedFTO: row[5] || '',
        hours: row[6] || '',
        phase: row[7] || '',
        strike: row[9] || '',
      });
    }
  }
  return map;
}

function sectionFor(member, sections) {
  const roleNames = member.roles.cache.map((r) => r.name.toLowerCase());
  const roleIds = new Set(member.roles.cache.map((r) => r.id));
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    for (const r of sec.roles || []) {
      const rl = String(r).toLowerCase();
      if (roleIds.has(r) || roleNames.includes(rl)) {
        const matchedRole = member.roles.cache.find(
          (x) => x.id === r || x.name.toLowerCase() === rl
        );
        return { index: i, role: matchedRole ? matchedRole.name : r };
      }
    }
  }
  return null;
}

function parseBadgeAndName(displayName) {
  const raw = String(displayName || '').trim();
  const pipeMatch = raw.match(/^(\d+)\s*\|\s*(.*)$/);
  if (pipeMatch) {
    return { badge: pipeMatch[1], name: pipeMatch[2].trim() || raw };
  }
  const spaceMatch = raw.match(/^(\d{3,})\s+(.+)$/);
  if (spaceMatch) {
    return { badge: spaceMatch[1], name: spaceMatch[2].trim() };
  }
  return { badge: '', name: raw };
}

function placeholderRow() {
  return ['', '', '', '', '', '', '', '', 'Inactive', 'none'];
}

const PROB_PHASE_PRIORITY = [
  { id: '1524971432151482509', name: 'Needs Interview', label: 'Needs Interview' },
  { id: '1327114656497668144', name: 'Needs Ridealong', label: 'Needs Ridealong' },
  { id: '1327114656497668145', name: 'Needs Training', label: 'Needs Training' },
  { id: '1327114656497668147', name: 'Probationary Trooper', label: 'Probationary' },
];

function probationaryPhase(member) {
  const roleIds = new Set(member.roles.cache.map((r) => r.id));
  const roleNames = member.roles.cache.map((r) => r.name.toLowerCase());
  const hasTraining = roleIds.has('1327114656497668145') || roleNames.includes('needs training');
  const hasInterview = roleIds.has('1524971432151482509') || roleNames.includes('needs interview');
  const hasRidealong = roleIds.has('1327114656497668144') || roleNames.includes('needs ridealong');
  if (hasTraining && hasInterview && hasRidealong) return 'ALL';
  for (const p of PROB_PHASE_PRIORITY) {
    if (roleIds.has(p.id) || roleNames.includes(p.name.toLowerCase())) {
      return p.label;
    }
  }
  return 'Probationary';
}

async function syncMembers(members) {
  const sheets = await getClient();
  await ensureSheet();
  const manual = await readExistingManual();
  const sections = loadSections();

  const hcMembers = [];
  const cmdMembers = [];
  const supMembers = [];
  const probMembers = [];
  for (const m of members) {
    const info = sectionFor(m, sections);
    if (!info) continue;
    if (info.index === 0) hcMembers.push({ member: m, rank: info.role });
    else if (info.index === 1) cmdMembers.push({ member: m, rank: info.role });
    else if (info.index === 2) supMembers.push({ member: m, rank: info.role });
    else if (info.index === 3) probMembers.push({ member: m, rank: 'Probationary Trooper' });
  }
  const sortFn = (a, b) =>
    (a.member.displayName || a.member.user.username).localeCompare(
      b.member.displayName || b.member.user.username
    );
  hcMembers.sort(sortFn);
  cmdMembers.sort(sortFn);
  supMembers.sort(sortFn);
  probMembers.sort(sortFn);

  function buildBlock(list, rows, phaseFor) {
    const block = [];
    for (let i = 0; i < rows; i++) {
      const item = list[i];
      if (item) {
        const m = item.member;
        const id = m.id;
        const man = manual.get(id) || {};
        const parsed = parseBadgeAndName(m.displayName || m.nickname || m.user.username);
        block.push([
          '',
          parsed.name,
          parsed.badge || man.badge || '',
          item.rank,
          id,
          man.assignedFTO || '',
          man.hours || '',
          phaseFor ? phaseFor(m) : 'Certified',
          'Active',
          man.strike || 'none',
        ]);
      } else {
        block.push(placeholderRow());
      }
    }
    return block;
  }

  const hcBlock = buildBlock(hcMembers, HC_ROWS, () => 'Certified');
  const cmdBlock = buildBlock(cmdMembers, CMD_ROWS, () => 'Certified');
  const supBlock = buildBlock(supMembers, SUP_ROWS, () => 'Certified');
  const probBlock = buildBlock(probMembers, PROB_ROWS, probationaryPhase);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${HC_START_ROW}:J${HC_START_ROW + HC_ROWS - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: hcBlock },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${CMD_START_ROW}:J${CMD_START_ROW + CMD_ROWS - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: cmdBlock },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${SUP_START_ROW}:J${SUP_START_ROW + SUP_ROWS - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: supBlock },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${PROB_START_ROW}:J${PROB_START_ROW + PROB_ROWS - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: probBlock },
  });

  if (sheetIdCache != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: { sheetId: sheetIdCache, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
              properties: { pixelSize: 170 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: sheetIdCache, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
              properties: { pixelSize: 190 },
              fields: 'pixelSize',
            },
          },
          {
            repeatCell: {
              range: { sheetId: sheetIdCache, startRowIndex: HC_START_ROW - 1, endRowIndex: HC_START_ROW - 1 + HC_ROWS, startColumnIndex: 1, endColumnIndex: 4 },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment',
            },
          },
          {
            repeatCell: {
              range: { sheetId: sheetIdCache, startRowIndex: CMD_START_ROW - 1, endRowIndex: CMD_START_ROW - 1 + CMD_ROWS, startColumnIndex: 1, endColumnIndex: 4 },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment',
            },
          },
          {
            repeatCell: {
              range: { sheetId: sheetIdCache, startRowIndex: SUP_START_ROW - 1, endRowIndex: SUP_START_ROW - 1 + SUP_ROWS, startColumnIndex: 1, endColumnIndex: 4 },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment',
            },
          },
          {
            repeatCell: {
              range: { sheetId: sheetIdCache, startRowIndex: PROB_START_ROW - 1, endRowIndex: PROB_START_ROW - 1 + PROB_ROWS, startColumnIndex: 1, endColumnIndex: 4 },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment',
            },
          },
        ],
      },
    });
  }

  // Count all members on roster (managed + any manually entered)
  const allIds = new Set(manual.keys());
  for (const x of hcMembers) allIds.add(x.member.id);
  for (const x of cmdMembers) allIds.add(x.member.id);
  const totalCount = allIds.size;

  // Write member count at D71/E71
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!D71`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Member count :']] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!E71`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[totalCount]] },
  });

  // Clear old member-count location from previous template
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!B62:C62`,
  });

  // Update dashboard last-sync timestamp (best effort)
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Dashboard!B14`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[new Date().toISOString()]] },
    });
  } catch (e) {
    // Dashboard tab may not exist; ignore
  }

  return hcMembers.length + cmdMembers.length + supMembers.length + probMembers.length;
}

async function setAssignedFTO(discordId, ftoName) {
  const sheets = await getClient();
  await ensureSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][4] || '').toString().trim() === String(discordId)) {
      const row = i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!F${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[ftoName]] },
      });
      return true;
    }
  }
  return false;
}

async function getAssignedFTO(discordId) {
  const map = await getAssignedFTOMap();
  return map.get(String(discordId)) || '';
}

async function getAssignedFTOMap() {
  const sheets = await getClient();
  await ensureSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = res.data.values || [];
  const map = new Map();
  for (const row of rows) {
    const id = (row[4] || '').toString().trim();
    if (/^\d{15,20}$/.test(id)) {
      map.set(id, row[5] || '');
    }
  }
  return map;
}

async function setStatus(discordId, status) {
  const sheets = await getClient();
  await ensureSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][4] || '').toString().trim() === String(discordId)) {
      const row = i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!I${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[status]] },
      });
      return true;
    }
  }
  return false;
}

const AUDIT_SHEET = process.env.AUDIT_SHEET_NAME || 'Audit Log';
const SCHEDULE_SHEET = process.env.SCHEDULE_SHEET_NAME || 'Schedule';

async function ensureAuditSheet() {
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sh = meta.data.sheets.find((s) => s.properties.title === AUDIT_SHEET);
  if (!sh) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: AUDIT_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${AUDIT_SHEET}!A1:E1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Timestamp', 'Actor', 'Action', 'Target', 'Details']] },
    });
  }
}

async function appendAudit({ timestamp, actor, action, target, details }) {
  await ensureAuditSheet();
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${AUDIT_SHEET}!A:E`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[timestamp, actor, action, target || '', details || '']] },
  });
}

async function ensureScheduleSheet() {
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sh = meta.data.sheets.find((s) => s.properties.title === SCHEDULE_SHEET);
  if (!sh) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SCHEDULE_SHEET } } }] },
    });
  }
  // Always ensure header row has all columns (A:Q)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!A1:Q1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['ID', 'Probationary', 'Probationary ID', 'Type', 'Date', 'Time', 'Duration', 'Notes', 'Status', 'Claimed By', 'Claimed At', 'Channel ID', 'Message ID', 'Created At', 'Completed By', 'Completed At', 'Reminded At']] },
  });
}

async function appendSchedule(data) {
  await ensureScheduleSheet();
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!A:Q`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        data.id,
        data.probationary || '',
        data.probationaryId || '',
        data.type || '',
        data.date || '',
        data.time || '',
        data.duration || '',
        data.notes || '',
        data.status || 'Open',
        data.claimedBy || '',
        data.claimedAt || '',
        data.channelId || '',
        data.messageId || '',
        data.createdAt || new Date().toISOString(),
        data.completedBy || '',
        data.completedAt || '',
        data.remindedAt || '',
      ]],
    },
  });
  return data.id;
}

async function getSchedule(id) {
  await ensureScheduleSheet();
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!A:Q`,
  });
  const rows = res.data.values || [];
  for (const row of rows) {
    if ((row[0] || '').toString().trim() === String(id)) {
      return {
        id: row[0] || '',
        probationary: row[1] || '',
        probationaryId: row[2] || '',
        type: row[3] || '',
        date: row[4] || '',
        time: row[5] || '',
        duration: row[6] || '',
        notes: row[7] || '',
        status: row[8] || '',
        claimedBy: row[9] || '',
        claimedAt: row[10] || '',
        channelId: row[11] || '',
        messageId: row[12] || '',
        createdAt: row[13] || '',
        completedBy: row[14] || '',
        completedAt: row[15] || '',
        remindedAt: row[16] || '',
      };
    }
  }
  return null;
}

async function getAllSchedules() {
  await ensureScheduleSheet();
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!A:Q`,
  });
  const rows = res.data.values || [];
  const out = [];
  for (const row of rows) {
    if (!row[0]) continue;
    if (row[0] === 'ID') continue;
    out.push({
      id: row[0] || '',
      probationary: row[1] || '',
      probationaryId: row[2] || '',
      type: row[3] || '',
      date: row[4] || '',
      time: row[5] || '',
      duration: row[6] || '',
      notes: row[7] || '',
      status: row[8] || '',
      claimedBy: row[9] || '',
      claimedAt: row[10] || '',
      channelId: row[11] || '',
      messageId: row[12] || '',
      createdAt: row[13] || '',
      completedBy: row[14] || '',
      completedAt: row[15] || '',
      remindedAt: row[16] || '',
    });
  }
  return out;
}

async function updateSchedule(id, updates) {
  await ensureScheduleSheet();
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!A:Q`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').toString().trim() === String(id)) {
      const row = i + 1;
      const vals = rows[i].slice();
      while (vals.length < 17) vals.push('');
      if (updates.status !== undefined) vals[8] = updates.status;
      if (updates.claimedBy !== undefined) vals[9] = updates.claimedBy;
      if (updates.claimedAt !== undefined) vals[10] = updates.claimedAt;
      if (updates.channelId !== undefined) vals[11] = updates.channelId;
      if (updates.messageId !== undefined) vals[12] = updates.messageId;
      if (updates.completedBy !== undefined) vals[14] = updates.completedBy;
      if (updates.completedAt !== undefined) vals[15] = updates.completedAt;
      if (updates.remindedAt !== undefined) vals[16] = updates.remindedAt;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SCHEDULE_SHEET}!A${row}:Q${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [vals] },
      });
      return true;
    }
  }
  return false;
}

module.exports = { syncMembers, ensureSheet, setAssignedFTO, getAssignedFTO, getAssignedFTOMap, probationaryPhase, setStatus, appendAudit, ensureScheduleSheet, appendSchedule, getSchedule, getAllSchedules, updateSchedule };