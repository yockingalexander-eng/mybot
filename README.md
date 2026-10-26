# Discord FTO -> Google Sheets Bot

Node.js (discord.js) bot that keeps a Google Sheet updated with members who have the
Field Training Officer (FTO) role. Updates automatically on role changes and supports
a manual `/syncfto` slash command.

## 1. Discord setup

1. Go to https://discord.com/developers/applications -> New Application.
2. Bot tab -> Add Bot -> copy the **Token** into `.env` as `DISCORD_TOKEN`.
3. Enable **Privileged Gateway Intents**: Server Members Intent (required).
4. OAuth2 -> URL Generator: scopes `bot` + `applications.commands`, permissions
   `View Channels`, `Manage Roles` (or at least read members). Invite bot to your server.
5. Copy your server (guild) ID into `.env` as `DISCORD_GUILD_ID`.
6. (Optional) Copy Application ID into `.env` as `DISCORD_CLIENT_ID`.

The FTO role ID is already set: `1327114656489406534`.

## 2. Google Cloud / Sheets setup (step by step)

1. Go to https://console.cloud.google.com and create/select a project.
2. Enable the **Google Sheets API**:
   APIs & Services -> Library -> search "Google Sheets API" -> Enable.
3. Create a Service Account:
   APIs & Services -> Credentials -> Create Credentials -> Service Account.
   Give it a name, finish.
4. Create a key:
   Click the service account -> Keys tab -> Add Key -> Create new key -> JSON.
   Download the JSON file and save it in this project folder as `credentials.json`.
   (This file is gitignored; never commit it.)
5. Create a Google Sheet (or use an existing one):
   - Copy the spreadsheet ID from the URL:
     `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
   - Put it in `.env` as `GOOGLE_SHEET_ID`.
6. Share the sheet with the service account email (found inside credentials.json as
   `client_email`, looks like `...@....iam.gserviceaccount.com`) with **Editor** access.
   The bot will create a tab named by `SHEET_NAME` (default `FTOs`) if missing.

## 3. Run

```bash
npm install
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## 4. Test

In Discord, run `/syncfto`. The sheet should populate with FTO members.

## Notes

- Requires Node.js 18+.
- The bot currently maintains only the High-command block (rows 11-20 of the
  `Roster` tab). Other sections (Command, Supervisors, Probationary Troopers) are
  left untouched so manually entered data is preserved.
- Phase is set to "Certified" and Status to "Active" for high-command members.
- Keep `credentials.json` and `.env` secret.

## Deploying to Railway (or other containers)

`credentials.json` is gitignored, so it is NOT present in the deployed image.
To authenticate Google Sheets on Railway, set one of these environment variables
in the Railway service settings (Variables tab):

- `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the **entire contents** of `credentials.json`
  as a single-line JSON string. This takes precedence over the key file.
- (Alternative) `GOOGLE_SERVICE_ACCOUNT_KEY` — base64-encoded contents of
  `credentials.json`.

The bot reads these automatically and falls back to `./credentials.json` for
local development. If neither is present, sync will fail with a clear error
instead of a cryptic `ENOENT`.

Quick way to produce the value locally (PowerShell):
```powershell
Get-Content .\credentials.json -Raw
```
Or base64:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('.\credentials.json'))
```