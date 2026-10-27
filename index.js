require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { syncMembers, setStatus, appendAudit, ensureScheduleSheet, appendSchedule, getSchedule, getAllSchedules, updateSchedule } = require('./sheets');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!GUILD_ID) console.warn('DISCORD_GUILD_ID is not set; roster sync and panels will be disabled.');
const FTO_ROLE_ID = process.env.FTO_ROLE_ID;
const APPLICANT_CHANNEL_ID = '1327114656942391374';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || null;
const SECTIONS_FILE = process.env.SECTIONS_FILE || './sections.json';

function loadSections() {
  try {
    return JSON.parse(fs.readFileSync(SECTIONS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName('syncfto')
    .setDescription('Sync roster (by role) to Google Sheet'),
  new SlashCommandBuilder()
    .setName('graduate')
    .setDescription('Mark a member as Graduated in the roster')
    .addUserOption((opt) => opt.setName('member').setDescription('The member to graduate').setRequired(true)),
  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Request an FTO session (interview, ride-along, or training)')
    .addStringOption((opt) =>
      opt.setName('type').setDescription('Session type(s), comma-separated (Interview, Ride-Along, Training)').setRequired(true)
    )
    .addStringOption((opt) => opt.setName('date').setDescription('Date (YYYY-MM-DD)').setRequired(true))
    .addStringOption((opt) => opt.setName('time').setDescription('Time (HH:MM)').setRequired(true))
    .addIntegerOption((opt) => opt.setName('duration').setDescription('Duration in minutes (default 60)').setRequired(false))
    .addStringOption((opt) => opt.setName('notes').setDescription('Notes').setRequired(false)),
  new SlashCommandBuilder().setName('myschedule').setDescription('View your schedule requests'),
  new SlashCommandBuilder().setName('openrequests').setDescription('View open (unclaimed) schedule requests'),
  new SlashCommandBuilder()
    .setName('reopenschedule')
    .setDescription('Reopen a completed/no-show schedule back to claimed')
    .addStringOption((opt) => opt.setName('id').setDescription('Schedule ID (e.g. SCH-...)').setRequired(true)),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const clientId = CLIENT_ID || (await client.application.fetch()).id;
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: commands.map((c) => c.toJSON()) });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands.map((c) => c.toJSON()) });
  }
  console.log('Slash commands registered.');
}

function isRosterMember(member, sections) {
  const names = new Set(member.roles.cache.map((r) => r.name.toLowerCase()));
  const ids = new Set(member.roles.cache.map((r) => r.id));
  for (const sec of sections) {
    for (const r of sec.roles || []) {
      if (ids.has(r) || names.has(String(r).toLowerCase())) return true;
    }
  }
  return false;
}

async function fetchMembersWithRetry(guild, attempts = 6) {
  if (membersLoaded && guild.members.cache.size > 0) {
    return guild.members.cache;
  }
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await guild.members.fetch();
      membersLoaded = true;
      return result;
    } catch (e) {
      const retryAfter = (e?.data?.retry_after || e?.retryAfter || 5) * 1000;
      if (i < attempts - 1) {
        console.warn(`Member fetch rate limited; retrying in ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter + 500));
      } else {
        throw e;
      }
    }
  }
}

async function syncRoster(guild) {
  await fetchMembersWithRetry(guild);
  const sections = loadSections();
  const rosterMembers = guild.members.cache.filter((m) => !m.user.bot && isRosterMember(m, sections));
  const count = await syncMembers([...rosterMembers.values()]);
  console.log(`Synced ${count} roster members to sheet.`);
  return count;
}

let syncChain = Promise.resolve();
let lastSyncAt = 0;
let membersLoaded = false;
function runSync(guild) {
  syncChain = syncChain
    .then(() => syncRoster(guild))
    .then((count) => { lastSyncAt = Date.now(); return count; })
    .catch((e) => console.error('Sync failed:', e));
  return syncChain;
}

async function postCommandGuide(guild) {
  const channelId = '1563951331587399710';
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.log('fto-announcement channel not found or not text-based.');
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('FTO Command Guide')
    .setDescription('Quick reference for Field Training Officers. All commands work anywhere in the server.')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Slash Commands', value:
        '`/schedule` — Request an FTO session. Type(s) comma-separated (e.g. `Interview, Ride-Along`), plus date, time, duration, notes. Pings all FTOs.\n' +
        '`/myschedule` — View your own schedule requests and their status.\n' +
        '`/openrequests` — View all open (unclaimed) schedule requests.\n' +
        '`/reopenschedule <id>` — Reopen a completed or no-show schedule (FTO only).\n' +
        '`/syncfto` — Manually sync the roster to the Google Sheet (admin).\n' +
        '`/graduate @member` — Mark a member as Graduated in the roster (admin).',
        inline: false },
      { name: 'Button Flows', value:
        'Schedule panel (applicant channel) — "Create Schedule" opens a form; or use `/schedule`.\n' +
        'Claim — FTO claims an open request; applicant is notified.\n' +
        'Complete / No-Show — type `COMPLETE` or `NO-SHOW` to confirm; marks done and adds a Reopen button.\n' +
        'Reopen — reverts a completed/no-show schedule back to Claimed or Open.\n' +
        'Cancel — requester cancels their own open request.',
        inline: false },
      { name: 'Tips', value:
        'You can request multiple session types in one request (e.g. `Interview, Ride-Along`).\n' +
        'Statuses: Open → Claimed → Completed / No-Show / Canceled.\n' +
        'If you complete a session by accident, use the Reopen button or `/reopenschedule`.',
        inline: false }
    );
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages
    ? messages.find((m) => m.author.id === client.user.id && m.embeds.some((e) => e.title === 'FTO Command Guide'))
    : null;
  if (existing) {
    await existing.edit({ embeds: [embed] }).catch((e) => console.error('guide edit failed', e?.message));
    console.log('Updated existing command guide in fto-announcement.');
  } else {
    await channel.send({ embeds: [embed] }).catch((e) => console.error('guide send failed', e?.message));
    console.log('Posted new command guide in fto-announcement.');
  }
}

async function createScheduleRequest(interaction, data) {
  console.log('createScheduleRequest start', data);
  const guild = interaction.guild;
  const type = normalizeTypes(data.type);
  const { date, time } = data;
  const notes = data.notes || '';
  if (!date || !time) {
    const reply = interaction.deferred || interaction.replied ? interaction.editReply : interaction.reply.bind(interaction);
    await reply({ content: 'Date and time are required.' }).catch(() => {});
    return;
  }
  const id = `SCH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = new Date().toISOString();
  console.log('createScheduleRequest: appending', id);
  try {
    await appendSchedule({
    id,
    probationary: interaction.user.displayName || interaction.user.username,
    probationaryId: interaction.user.id,
    type,
    date,
    time,
    duration: data.duration || '',
    notes,
    status: 'Open',
    channelId: APPLICANT_CHANNEL_ID,
    messageId: '',
    createdAt,
  });
  } catch (e) { console.error('appendSchedule failed', e); throw e; }
  console.log('createScheduleRequest: appended, fetching channel');
  const channel = await client.channels.fetch(APPLICANT_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    const reply = interaction.deferred || interaction.replied ? interaction.editReply : interaction.reply.bind(interaction);
    await reply({ content: 'Scheduling channel not found.' }).catch(() => {});
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(`Schedule Request: ${type}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Newcomer', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Type', value: type, inline: true },
      { name: 'Date', value: date, inline: true },
      { name: 'Time', value: time, inline: true },
      { name: 'Notes', value: notes || '-', inline: false },
      { name: 'Status', value: 'Open — awaiting FTO claim', inline: false }
    )
    .setFooter({ text: `Request ID: ${id}` });
  const claimBtn = new ButtonBuilder().setCustomId(`sched_claim:${id}`).setLabel('Claim').setStyle(ButtonStyle.Success);
  const cancelBtn = new ButtonBuilder().setCustomId(`sched_cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(claimBtn, cancelBtn);
  const content = `<@&${FTO_ROLE_ID}> New schedule request:`;
  console.log('createScheduleRequest: sending message');
  const msg = await channel.send({ content, embeds: [embed], components: [row] }).catch((e) => { console.error('channel send failed', e?.message); return null; });
  if (msg) {
    await updateSchedule(id, { messageId: msg.id, channelId: APPLICANT_CHANNEL_ID });
  }
  await auditLog(interaction.guild, {
    actor: interaction.user.displayName || interaction.user.username,
    action: 'Schedule Requested',
    target: type,
    details: `${date} ${time} ID ${id}`,
  });
  const reply = interaction.deferred || interaction.replied ? interaction.editReply : interaction.reply.bind(interaction);
  await reply({ content: `Your schedule request has been posted in <#${APPLICANT_CHANNEL_ID}>.` }).catch(() => {});
  console.log('createScheduleRequest: done');
}

async function auditLog(guild, { actor, action, target, details }) {
  const ts = new Date().toISOString();
  try {
    await appendAudit({ timestamp: ts, actor, action, target, details });
  } catch (e) {
    console.error('Audit sheet write failed:', e?.message || e);
  }
  const channelId = process.env.AUDIT_CHANNEL_ID;
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('FTO Audit Log')
          .setColor(0x5865f2)
          .addFields(
            { name: 'Time', value: ts, inline: true },
            { name: 'Actor', value: String(actor || 'unknown'), inline: true },
            { name: 'Action', value: String(action || ''), inline: true },
            { name: 'Target', value: String(target || '—'), inline: true },
            { name: 'Details', value: String(details || '—').slice(0, 1024), inline: false }
          );
        await ch.send({ embeds: [embed] });
      }
    } catch (e) {
      console.error('Audit channel post failed:', e?.message || e);
    }
  }
  console.log(`[AUDIT] ${actor} | ${action} | ${target} | ${details}`);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    c.user.setPresence({ status: 'online', activities: [{ name: 'FTO Roster', type: 3 }] });
  } catch (e) {
    console.error('Presence set failed:', e?.message || e);
  }
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      try {
        const ftoRole = guild.roles.cache.get(FTO_ROLE_ID) || await guild.roles.fetch(FTO_ROLE_ID).catch(() => null);
        if (ftoRole && !ftoRole.mentionable) {
          await ftoRole.setMentionable(true, 'Enable FTO role pings for schedule requests');
          console.log('Set FTO role mentionable.');
        }
      } catch (e) { console.error('Failed to set FTO role mentionable:', e?.message || e); }
      await runSync(guild);
      await ensureScheduleSheet().catch((e) => console.error('Schedule sheet init failed:', e));
      await postSchedulePanel(guild).catch((e) => console.error('Schedule panel post failed:', e));
      await postCommandGuide(guild).catch((e) => console.error('Command guide post failed:', e));
      // Periodic reminder for unclaimed schedule requests (24h+)
      setInterval(async () => {
        try {
          const all = await getAllSchedules();
          const now = Date.now();
          for (const s of all) {
            if (s.status !== 'Open' || s.remindedAt) continue;
            const created = new Date(s.createdAt).getTime();
            if (!created || now - created < 24 * 60 * 60 * 1000) continue;
            const channel = await client.channels.fetch(s.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) continue;
            const content = `<@&${FTO_ROLE_ID}> Reminder: unclaimed schedule request:`;
            const embed = new EmbedBuilder()
              .setTitle('Unclaimed Schedule Reminder')
              .setColor(0xffa500)
              .addFields(
                { name: 'Newcomer', value: `<@${s.probationaryId}>`, inline: true },
                { name: 'Type', value: s.type, inline: true },
                { name: 'Date', value: s.date, inline: true },
                { name: 'Time', value: s.time, inline: true },
                { name: 'Notes', value: s.notes || '—', inline: false },
                { name: 'Request ID', value: s.id, inline: false }
              );
            await channel.send({ content, embeds: [embed] }).catch(() => {});
            await updateSchedule(s.id, { remindedAt: new Date().toISOString() });
          }
        } catch (e) {
          console.error('Reminder check failed:', e);
        }
      }, 60 * 60 * 1000);
      // Periodic safety sync to catch any missed join/role events
      setInterval(() => {
        if (Date.now() - lastSyncAt < 120000) return;
        const g = client.guilds.cache.get(GUILD_ID);
        if (g) runSync(g).catch((e) => console.error('Periodic sync failed:', e));
      }, 300000);
      // Keep presence green even after reconnects
      setInterval(() => {
        try { client.user?.setPresence({ status: 'online', activities: [{ name: 'FTO Roster', type: 3 }] }); } catch (e) {}
      }, 600000);
    }
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const oldRoles = [...(oldMember?.roles?.cache?.keys() || [])].sort().join(',');
  const newRoles = [...newMember.roles.cache.keys()].sort().join(',');
  const sections = loadSections();
  const wasRoster = oldMember ? isRosterMember(oldMember, sections) : false;
  const isNowRoster = isRosterMember(newMember, sections);
  if (oldRoles !== newRoles || (!wasRoster && isNowRoster)) {
    console.log(`Roles changed for ${newMember.user.tag}`);
    await runSync(newMember.guild);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`Member joined: ${member.user.tag}`);
  if (!member.user.bot) {
    try {
      const embed = new EmbedBuilder()
        .setTitle('Welcome to MCRP | Wisconsin State Patrol')
        .setDescription('Thanks for joining! To get started with Field Training, request a session using the `/schedule` command or the button in the applicant channel.')
        .setColor(0x5865f2)
        .addFields(
          { name: 'Session types', value: 'Interview, Ride-Along, Training', inline: true },
          { name: 'Where', value: '<#1327114656942391374>', inline: true },
          { name: 'How', value: 'Use `/schedule` or click "Create Schedule" in the applicant channel.', inline: false }
        );
      await member.send({ embeds: [embed] });
    } catch (e) {
      console.log('Welcome DM failed:', e?.message || e);
    }
  }
  // Fetch fresh so auto-assigned roles are present
  try { await member.fetch(true); } catch (e) { console.warn('Member fetch on join failed:', e?.message); }
  const sections = loadSections();
  if (isRosterMember(member, sections)) {
    await runSync(member.guild);
  }
  // Roles are sometimes applied a few seconds after join; catch that case too
  setTimeout(() => {
    runSync(member.guild).catch((e) => console.error('Delayed join sync failed:', e));
  }, 10000);
});

client.on(Events.GuildMemberRemove, async (member) => {
  await runSync(member.guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    // Allow commands anywhere in the guild
    if (interaction.commandName === 'syncfto') {
      await interaction.deferReply({ flags: 64 });
      try {
        const guild = interaction.guild;
        const count = await runSync(guild);
        await auditLog(guild, {
          actor: interaction.user.displayName || interaction.user.username,
          action: 'Manual Sync',
          target: 'Roster',
          details: `${count} members synced`,
        });
        await interaction.editReply(`Synced ${count} roster members to Google Sheet.`);
      } catch (e) {
        console.error(e);
        await interaction.editReply('Sync failed. Check bot logs.');
      }
    } else if (interaction.commandName === 'graduate') {
      await interaction.deferReply({ flags: 64 });
      try {
        const target = interaction.options.getUser('member');
        const ok = await setStatus(target.id, 'Graduated');
        if (ok) {
          await auditLog(interaction.guild, {
            actor: interaction.user.displayName || interaction.user.username,
            action: 'Graduate',
            target: target.tag || target.username,
            details: `Discord ID ${target.id}`,
          });
          await interaction.editReply(`Marked ${target} as Graduated in the roster.`);
        } else {
          await interaction.editReply('Member not found in roster.');
        }
      } catch (e) {
        console.error(e);
        await interaction.editReply('Failed to update status.');
      }
    } else if (interaction.commandName === 'schedule') {
      await interaction.deferReply({ flags: 64 });
      const data = {
        type: interaction.options.getString('type'),
        date: interaction.options.getString('date'),
        time: interaction.options.getString('time'),
        duration: interaction.options.getInteger('duration'),
        notes: interaction.options.getString('notes'),
      };
      await createScheduleRequest(interaction, data);
    } else if (interaction.commandName === 'myschedule') {
      await interaction.deferReply({ flags: 64 });
      const all = await getAllSchedules();
      const mine = all.filter((s) => s.probationaryId === interaction.user.id);
      if (!mine.length) {
        await interaction.editReply('You have no schedule requests.');
        return;
      }
      const lines = mine.map((s) => `• ${s.type} on ${s.date} at ${s.time} — **${s.status}**${s.claimedBy ? ` (claimed by ${s.claimedBy})` : ''} (ID: ${s.id})`);
      await interaction.editReply(lines.join('\n').slice(0, 1900));
    } else if (interaction.commandName === 'openrequests') {
      await interaction.deferReply({ flags: 64 });
      const all = await getAllSchedules();
      const open = all.filter((s) => s.status === 'Open');
      if (!open.length) {
        await interaction.editReply('No open schedule requests.');
        return;
      }
      const lines = open.map((s) => `• ${s.probationary}: ${s.type} on ${s.date} at ${s.time} (ID: ${s.id})`);
      await interaction.editReply(lines.join('\n').slice(0, 1900));
    } else if (interaction.commandName === 'reopenschedule') {
      await interaction.deferReply({ flags: 64 });
      try {
        const id = interaction.options.getString('id');
        const sched = await getSchedule(id);
        if (!sched) { await interaction.editReply('Schedule not found.'); return; }
        const hasFTO = interaction.member?.roles?.cache?.has?.(FTO_ROLE_ID) || interaction.member?.roles?.cache?.some?.((r) => /field training officer/i.test(r.name));
        if (!hasFTO) { await interaction.editReply('Only FTOs can reopen schedules.'); return; }
        const reopenStatus = sched.claimedBy ? 'Claimed' : 'Open';
        await updateSchedule(id, { status: reopenStatus, completedBy: '', completedAt: '' });
        const channel = await client.channels.fetch(sched.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
        if (channel && sched.messageId) {
          const msg = await channel.messages.fetch(sched.messageId).catch(() => null);
          if (msg) {
            const embed = EmbedBuilder.from(msg.embeds[0]).setFields(
              msg.embeds[0].fields.map((f) => (f.name === 'Status' ? { name: 'Status', value: reopenStatus === 'Claimed' ? `Claimed by ${sched.claimedBy}` : 'Open — awaiting FTO claim', inline: false } : f))
            );
            let components = [];
            if (reopenStatus === 'Claimed') {
              const completeBtn = new ButtonBuilder().setCustomId(`sched_complete:${id}`).setLabel('Complete').setStyle(ButtonStyle.Success);
              const noshowBtn = new ButtonBuilder().setCustomId(`sched_noshow:${id}`).setLabel('No-Show').setStyle(ButtonStyle.Danger);
              components = [new ActionRowBuilder().addComponents(completeBtn, noshowBtn)];
            } else {
              const claimBtn = new ButtonBuilder().setCustomId(`sched_claim:${id}`).setLabel('Claim').setStyle(ButtonStyle.Success);
              const cancelBtn = new ButtonBuilder().setCustomId(`sched_cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger);
              components = [new ActionRowBuilder().addComponents(claimBtn, cancelBtn)];
            }
            await msg.edit({ embeds: [embed], components }).catch(() => {});
          }
        }
        await auditLog(interaction.guild, {
          actor: interaction.user.displayName || interaction.user.username,
          action: 'Schedule Reopened',
          target: sched.probationary,
          details: `${sched.type} ${sched.date} ${sched.time} ID ${id}`,
        });
        await interaction.editReply(`Reopened schedule ${id} (${reopenStatus}).`);
      } catch (e) {
        console.error(e);
        await interaction.editReply('Failed to reopen schedule.');
      }
    }
    return;
  }

  if (interaction.isButton()) {
    // Schedule: create button opens a modal
    if (interaction.customId === 'sched_create') {
      console.log('sched_create clicked by', interaction.user.tag);
      try {
        const modal = new ModalBuilder().setCustomId('sched_modal').setTitle('Create Schedule');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type').setLabel('Type(s) (Interview/Ride-Along/Training)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date (MM-DD-YYYY)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Time (any format)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('Notes').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
      await interaction.showModal(modal);
      return;
      } catch (e) {
        console.error('sched_create failed', e);
        await interaction.reply({ content: 'Failed to open form.', flags: 64 }).catch(() => {});
      }
    }
    const [action, memberId] = interaction.customId.split(':');
    if (action === 'sched_reopen') {
      try {
        await interaction.deferUpdate();
        const id = memberId;
        const sched = await getSchedule(id);
        if (!sched) { await interaction.followUp({ content: 'Schedule request not found.', flags: 64 }); return; }
        const hasFTO = interaction.member?.roles?.cache?.has?.(FTO_ROLE_ID) || interaction.member?.roles?.cache?.some?.((r) => /field training officer/i.test(r.name));
        if (!hasFTO) { await interaction.followUp({ content: 'Only FTOs can reopen requests.', flags: 64 }); return; }
        const reopenStatus = sched.claimedBy ? 'Claimed' : 'Open';
        await updateSchedule(id, { status: reopenStatus, completedBy: '', completedAt: '' });
        const channel = await client.channels.fetch(sched.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
        if (channel && sched.messageId) {
          const msg = await channel.messages.fetch(sched.messageId).catch(() => null);
          if (msg) {
            const embed = EmbedBuilder.from(msg.embeds[0]).setFields(
              msg.embeds[0].fields.map((f) => (f.name === 'Status' ? { name: 'Status', value: reopenStatus === 'Claimed' ? `Claimed by ${sched.claimedBy}` : 'Open — awaiting FTO claim', inline: false } : f))
            );
            let components = [];
            if (reopenStatus === 'Claimed') {
              const completeBtn = new ButtonBuilder().setCustomId(`sched_complete:${id}`).setLabel('Complete').setStyle(ButtonStyle.Success);
              const noshowBtn = new ButtonBuilder().setCustomId(`sched_noshow:${id}`).setLabel('No-Show').setStyle(ButtonStyle.Danger);
              components = [new ActionRowBuilder().addComponents(completeBtn, noshowBtn)];
            } else {
              const claimBtn = new ButtonBuilder().setCustomId(`sched_claim:${id}`).setLabel('Claim').setStyle(ButtonStyle.Success);
              const cancelBtn = new ButtonBuilder().setCustomId(`sched_cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger);
              components = [new ActionRowBuilder().addComponents(claimBtn, cancelBtn)];
            }
            await msg.edit({ embeds: [embed], components }).catch((e) => console.error('msg edit failed', e?.message));
          }
        }
        await auditLog(interaction.guild, {
          actor: interaction.user.displayName || interaction.user.username,
          action: 'Schedule Reopened',
          target: sched.probationary,
          details: `${sched.type} ${sched.date} ${sched.time} ID ${id}`,
        });
        await interaction.followUp({ content: `Reopened schedule (${reopenStatus}).`, flags: 64 });
      } catch (e) {
        console.error(e);
        await interaction.followUp({ content: 'Failed to reopen request.', flags: 64 }).catch(() => {});
      }
      return;
    }
    // Complete / No-Show require a confirmation modal to avoid accidental clicks
    if (action === 'sched_complete' || action === 'sched_noshow') {
      try {
        const label = action === 'sched_complete' ? 'Complete' : 'No-Show';
        const modal = new ModalBuilder().setCustomId(`${action}_confirm:${memberId}`).setTitle(`Confirm ${label}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('confirm').setLabel(`Type ${label.toUpperCase()} to confirm`).setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
      } catch (e) {
        console.error('confirm modal failed', e);
        await interaction.reply({ content: 'Failed to open confirmation.', flags: 64 }).catch(() => {});
      }
      return;
    }
    if (action === 'sched_claim' || action === 'sched_cancel') {
      try {
        await interaction.deferUpdate();
        const id = memberId;
        const sched = await getSchedule(id);
        if (!sched) {
          await interaction.followUp({ content: 'Schedule request not found.', flags: 64 });
          return;
        }
        if (action === 'sched_claim') {
          if (sched.status !== 'Open') {
            await interaction.followUp({ content: 'This request is already claimed or canceled.', flags: 64 });
            return;
          }
          const ftoName = interaction.user.displayName || interaction.user.username;
          const hasFTO = interaction.member?.roles?.cache?.has?.(FTO_ROLE_ID) || interaction.member?.roles?.cache?.some?.((r) => /field training officer/i.test(r.name));
          if (!hasFTO) {
            await interaction.followUp({ content: 'Only FTOs can claim requests.', flags: 64 });
            return;
          }
          const now = new Date().toISOString();
          await updateSchedule(id, { status: 'Claimed', claimedBy: ftoName, claimedAt: now });
          const channel = await client.channels.fetch(sched.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
          // update original message
          if (channel && sched.messageId) {
            const msg = await channel.messages.fetch(sched.messageId).catch(() => null);
            if (msg) {
              const embed = EmbedBuilder.from(msg.embeds[0]).setFields(
                msg.embeds[0].fields.map((f) => (f.name === 'Status' ? { name: 'Status', value: `Claimed by ${ftoName}`, inline: false } : f))
              );
              const completeBtn = new ButtonBuilder().setCustomId(`sched_complete:${id}`).setLabel('Complete').setStyle(ButtonStyle.Success);
              const noshowBtn = new ButtonBuilder().setCustomId(`sched_noshow:${id}`).setLabel('No-Show').setStyle(ButtonStyle.Danger);
              const row = new ActionRowBuilder().addComponents(completeBtn, noshowBtn);
              await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
            }
          }
          await channel?.send({ content: `<@${sched.probationaryId}> your schedule request was claimed by ${ftoName}.` }).catch(() => {});
          await auditLog(interaction.guild, {
            actor: ftoName,
            action: 'Schedule Claimed',
            target: sched.probationary,
            details: `${sched.type} ${sched.date} ${sched.time} ID ${id}`,
          });
          await interaction.followUp({ content: `You claimed ${sched.probationary}'s ${sched.type} request.`, flags: 64 });
        } else if (action === 'sched_cancel') {
          // cancel
          if (sched.status !== 'Open') {
            await interaction.followUp({ content: 'Cannot cancel (already claimed or canceled).', flags: 64 });
            return;
          }
          if (interaction.user.id !== sched.probationaryId) {
            await interaction.followUp({ content: 'Only the requester can cancel.', flags: 64 });
            return;
          }
          await updateSchedule(id, { status: 'Canceled' });
          const channel = await client.channels.fetch(sched.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
          if (channel && sched.messageId) {
            const msg = await channel.messages.fetch(sched.messageId).catch(() => null);
            if (msg) {
              const embed = EmbedBuilder.from(msg.embeds[0]).setFields(
                msg.embeds[0].fields.map((f) => (f.name === 'Status' ? { name: 'Status', value: 'Canceled', inline: false } : f))
              );
              await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
            }
          }
          await auditLog(interaction.guild, {
            actor: interaction.user.displayName || interaction.user.username,
            action: 'Schedule Canceled',
            target: sched.probationary,
            details: `${sched.type} ${sched.date} ${sched.time} ID ${id}`,
          });
          await interaction.followUp({ content: 'Your schedule request was canceled.', flags: 64 });
        }
      } catch (e) {
        console.error(e);
        await interaction.followUp({ content: 'Failed to process request.', flags: 64 }).catch(() => {});
      }
      return;
    }

  if (interaction.isModalSubmit()) {
    const [modalAction, modalId] = interaction.customId.split(':');
    if (modalAction === 'sched_modal') {
      console.log('sched_modal submitted by', interaction.user.tag);
      await interaction.deferReply({ flags: 64 });
      const data = {
        type: normalizeTypes(interaction.fields.getTextInputValue('type')),
        date: interaction.fields.getTextInputValue('date'),
        time: interaction.fields.getTextInputValue('time'),
        duration: 60,
        notes: interaction.fields.getTextInputValue('notes'),
      };
      try {
        await createScheduleRequest(interaction, data);
      } catch (e) {
        console.error('createScheduleRequest failed', e);
        await interaction.editReply({ content: 'Failed to create schedule. Check bot logs.', flags: 64 }).catch(() => {});
      }
      return;
    }
    if (modalAction === 'sched_complete_confirm' || modalAction === 'sched_noshow_confirm') {
      await interaction.deferReply({ flags: 64 });
      try {
        const id = modalId;
        const sched = await getSchedule(id);
        if (!sched) { await interaction.editReply({ content: 'Schedule request not found.', flags: 64 }); return; }
        if (sched.status !== 'Claimed') { await interaction.editReply({ content: 'Request must be claimed first.', flags: 64 }); return; }
        const ftoName = interaction.user.displayName || interaction.user.username;
        const hasFTO = interaction.member?.roles?.cache?.has?.(FTO_ROLE_ID) || interaction.member?.roles?.cache?.some?.((r) => /field training officer/i.test(r.name));
        if (!hasFTO) { await interaction.editReply({ content: 'Only FTOs can close requests.', flags: 64 }); return; }
        const expected = modalAction === 'sched_complete_confirm' ? 'COMPLETE' : 'NO-SHOW';
        const typed = (interaction.fields.getTextInputValue('confirm') || '').trim().toUpperCase();
        if (typed !== expected) { await interaction.editReply({ content: `Confirmation failed. Type ${expected} exactly.`, flags: 64 }); return; }
        const newStatus = modalAction === 'sched_complete_confirm' ? 'Completed' : 'No-Show';
        const now = new Date().toISOString();
        await updateSchedule(id, { status: newStatus, completedBy: ftoName, completedAt: now });
        const channel = await client.channels.fetch(sched.channelId || APPLICANT_CHANNEL_ID).catch(() => null);
        if (channel && sched.messageId) {
          const msg = await channel.messages.fetch(sched.messageId).catch(() => null);
          if (msg) {
            const embed = EmbedBuilder.from(msg.embeds[0]).setFields(
              msg.embeds[0].fields.map((f) => (f.name === 'Status' ? { name: 'Status', value: newStatus, inline: false } : f))
            );
            const reopenBtn = new ButtonBuilder().setCustomId(`sched_reopen:${id}`).setLabel('Reopen').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(reopenBtn);
            await msg.edit({ embeds: [embed], components: [row] }).catch((e) => console.error('msg edit failed', e?.message));
          }
        }
        await auditLog(interaction.guild, {
          actor: ftoName,
          action: `Schedule ${newStatus}`,
          target: sched.probationary,
          details: `${sched.type} ${sched.date} ${sched.time} ID ${id}`,
        });
        await interaction.editReply({ content: `Marked as ${newStatus}.`, flags: 64 });
      } catch (e) {
        console.error(e);
        await interaction.editReply({ content: 'Failed to process request.', flags: 64 }).catch(() => {});
      }
      return;
    }
    return;
  }
}
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
client.on('error', (e) => console.error('Client error:', e));
client.login(TOKEN);