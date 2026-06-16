/**
 * ARTURITO AI — Sistema de tickets y correo (Firebase Functions Gen2)
 * Base Firestore: artutitohipodromo02
 *
 * processMailQueue  → mail/{mailId}     → envía SMTP + delivery + logs
 * notifyAdminOnTicket → tickets/{id}   → crea mail/{ticketId} si falta
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');

const FIRESTORE_DATABASE_ID = defineString('FIRESTORE_DATABASE_ID', {
  default: 'artutitohipodromo02'
});
const deploySmtpUri = defineString('SMTP_CONNECTION_URI', { default: '' });
const deploySmtpFrom = defineString('SMTP_FROM_EMAIL', { default: '' });
const deployAdminEmail = defineString('ADMIN_EMAIL', {
  default: 'activawalkermartinez815@gmail.com'
});

const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2500;
const PRIMARY_COLOR = '#0d9488';

initializeApp();

function db() {
  return getFirestore(FIRESTORE_DATABASE_ID.value());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseEmails(raw) {
  return String(raw || '')
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter(Boolean);
}

function parseSmtpUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/^smtps:\/\//i, 'https://').replace(/^smtp:\/\//i, 'http://');
    const url = new URL(normalized);
    const user = decodeURIComponent(url.username || '');
    const pass = decodeURIComponent(url.password || '');
    const host = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : (raw.startsWith('smtps') ? 465 : 587);
    const secure = port === 465 || raw.startsWith('smtps');
    if (!host || !user || !pass) return { uri: raw, from: user || undefined };
    return {
      uri: raw,
      from: user,
      transport: { host, port, secure, auth: { user, pass } }
    };
  } catch (err) {
    console.warn('[smtp] parseSmtpUri:', err.message);
    return { uri: raw, from: undefined };
  }
}

function normalizeAttachment(att) {
  if (!att) return null;
  return { name: att.name || att.nombre || 'adjunto', url: att.url || '' };
}

function formatTicketDate(ticket) {
  const ts = ticket.fechaCreacion || ticket.createdAt;
  if (!ts) return new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });
  const d = typeof ts === 'number' ? new Date(ts) : ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('es-CL', { timeZone: 'America/Santiago' });
}

function buildTicketEmail({ ticketId, condominioId, ticket, settings }) {
  const buildingName = settings.buildingName || 'Edificio';
  const adminPanelUrl = settings.adminPanelUrl || 'https://chatbots-hipodromo.web.app/admin';
  const logoText = String(settings.logo || buildingName.charAt(0) || 'A').slice(0, 3).toUpperCase();
  const primary = settings.primaryColor || PRIMARY_COLOR;
  const adjuntos = (ticket.adjuntos || []).map(normalizeAttachment).filter(Boolean);
  const fecha = formatTicketDate(ticket);

  const adjuntosRows = adjuntos.length
    ? adjuntos.map((a) => {
        const label = escapeHtml(a.name);
        const link = a.url
          ? `<a href="${escapeHtml(a.url)}" style="color:${primary};text-decoration:none">${label}</a>`
          : label;
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${link}</td></tr>`;
      }).join('')
    : `<tr><td style="padding:8px 12px;color:#6b7280;font-style:italic">Sin archivos adjuntos</td></tr>`;

  const subject = `[${buildingName}] Nuevo ticket ${ticketId} — ${ticket.categoria || 'Solicitud'}`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <tr><td style="background:${primary};padding:28px 32px;text-align:center">
    <div style="display:inline-block;width:52px;height:52px;line-height:52px;border-radius:12px;background:rgba(255,255,255,.2);color:#fff;font-weight:800;font-size:20px;margin-bottom:12px">${escapeHtml(logoText)}</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">${escapeHtml(buildingName)}</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,.9);font-size:14px">Nueva solicitud de atención</p>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <table role="presentation" width="100%" style="margin-bottom:20px"><tr><td style="background:#ecfdf5;border-left:4px solid ${primary};padding:14px 16px;border-radius:0 8px 8px 0">
      <strong style="color:${primary};font-size:13px;text-transform:uppercase;letter-spacing:.04em">Ticket</strong>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${escapeHtml(ticketId)}</div>
    </td></tr></table>
    <table role="presentation" width="100%" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px">
      ${row('Nombre', ticket.nombre)}
      ${row('Departamento', ticket.departamento)}
      ${row('Correo', ticket.email)}
      ${row('Categoría', ticket.categoria || ticket.asunto)}
      ${row('Prioridad', ticket.prioridad)}
      ${row('Estado', ticket.estado || 'Abierto')}
      ${row('Fecha', fecha)}
    </table>
    <h3 style="margin:0 0 8px;font-size:14px;color:#374151;text-transform:uppercase;letter-spacing:.03em">Descripción</h3>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;font-size:15px;line-height:1.6;color:#1f2937;white-space:pre-wrap">${escapeHtml(ticket.descripcion || '—')}</div>
    <h3 style="margin:24px 0 8px;font-size:14px;color:#374151;text-transform:uppercase;letter-spacing:.03em">Adjuntos</h3>
    <table role="presentation" width="100%" style="border:1px solid #e5e7eb;border-radius:8px">${adjuntosRows}</table>
    <table role="presentation" width="100%" style="margin-top:28px"><tr><td align="center">
      <a href="${escapeHtml(adminPanelUrl)}" style="display:inline-block;background:${primary};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">Abrir panel de tickets</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
    <p style="margin:0;font-size:12px;color:#9ca3af">${escapeHtml(buildingName)} · ${escapeHtml(condominioId)} · ARTURITO AI</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  function row(label, value) {
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;background:#f9fafb;width:35%;font-size:13px;color:#6b7280;font-weight:600">${escapeHtml(label)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827">${escapeHtml(value || '—')}</td>
    </tr>`;
  }

  const text = [
    `Nueva solicitud: ${ticketId}`,
    `Edificio: ${buildingName}`,
    `Fecha: ${fecha}`,
    `Nombre: ${ticket.nombre || '—'}`,
    `Departamento: ${ticket.departamento || '—'}`,
    `Correo: ${ticket.email || '—'}`,
    `Categoría: ${ticket.categoria || '—'}`,
    `Prioridad: ${ticket.prioridad || '—'}`,
    '',
    'Descripción:',
    ticket.descripcion || '—',
    '',
    adjuntos.length ? `Adjuntos: ${adjuntos.map((a) => a.url || a.name).join(', ')}` : 'Sin adjuntos',
    '',
    `Panel: ${adminPanelUrl}`
  ].join('\n');

  return { subject, html, text };
}

async function resolveRecipients(settings, condominioId) {
  let recipients = parseEmails(settings.notifyAdminEmail);
  if (recipients.length) return recipients;
  try {
    const snap = await db().doc(`condominios/${condominioId}/email_config/outbound`).get();
    if (snap.exists()) {
      const d = snap.data() || {};
      recipients = parseEmails(d.notifyAdminEmail || d.adminEmail || d.to);
      if (recipients.length) return recipients;
    }
  } catch (err) {
    console.warn('[email] email_config read:', err.message);
  }
  return parseEmails(deployAdminEmail.value() || process.env.ADMIN_EMAIL);
}

async function loadSmtpTransport(condominioId, settings = {}) {
  let uri = String(settings.smtpConnectionUri || '').trim();
  let from = String(settings.smtpFromEmail || settings.smtpFrom || '').trim();

  if (!uri) {
    try {
      const snap = await db().doc(`condominios/${condominioId}/email_config/outbound`).get();
      if (snap.exists()) {
        const cfg = snap.data() || {};
        uri = cfg.smtpConnectionUri || cfg.connectionUri || uri;
        from = from || cfg.fromEmail || cfg.from || cfg.smtpUser || '';
      }
    } catch (err) {
      console.warn('[email] email_config smtp:', err.message);
    }
  }

  if (!uri) uri = String(deploySmtpUri.value() || process.env.SMTP_CONNECTION_URI || '').trim();
  if (!from) from = String(deploySmtpFrom.value() || process.env.SMTP_FROM_EMAIL || '').trim();

  if (!uri) return null;

  const parsed = parseSmtpUri(uri);
  if (!parsed) return null;

  const transporter = parsed.transport
    ? nodemailer.createTransport(parsed.transport)
    : nodemailer.createTransport(uri);

  return { transporter, from: from || parsed.from || undefined };
}

function normalizeMailRecipients(to) {
  if (Array.isArray(to)) return to.map(String).filter(Boolean);
  return parseEmails(to);
}

function isAlreadySent(data) {
  const d = data?.delivery || {};
  return d.success === true || ['SUCCESS', 'DELIVERED'].includes(d.state);
}

const MAIL_BUSY = new Set(['PROCESSING', 'SUCCESS', 'DELIVERED']);

async function tryClaimMailDelivery(ref, processedBy) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, reason: 'missing' };
    const data = snap.data() || {};
    if (isAlreadySent(data)) return { claimed: false, reason: 'already_sent' };
    const state = data.delivery?.state;
    if (state && MAIL_BUSY.has(state)) return { claimed: false, reason: state };
    tx.update(ref, {
      delivery: {
        success: false,
        state: 'PROCESSING',
        processedBy,
        attempts: (data.delivery?.attempts || 0) + 1,
        at: FieldValue.serverTimestamp()
      }
    });
    return { claimed: true };
  });
}

async function writeMailLog(entry) {
  try {
    await db().collection('logs').doc('mail').collection('entries').add({
      ...entry,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('[mailLog]', err.message);
  }
}

async function markDelivery(ref, payload) {
  const delivery = {
    ...payload,
    at: FieldValue.serverTimestamp()
  };
  if (payload.success && !delivery.sentAt) {
    delivery.sentAt = FieldValue.serverTimestamp();
  }
  if (payload.success) {
    delivery.state = 'SUCCESS';
  } else if (payload.error) {
    delivery.state = 'ERROR';
    delivery.success = false;
  }
  await ref.update({ delivery });
  return delivery;
}

async function sendMailWithRetries({ ref, mailId, condominioId, recipients, message, replyTo, settings }) {
  const smtp = await loadSmtpTransport(condominioId, settings);
  if (!smtp) {
    const error = 'SMTP no configurado. Guarda Gmail+app password en settings/main o functions/.env';
    await markDelivery(ref, { success: false, error, processedBy: 'processMailQueue' });
    await writeMailLog({ ticketId: mailId, mailId, condominioId, to: recipients.join(', '), success: false, error });
    console.error(`[processMailQueue] ${mailId} sin SMTP`);
    return { ok: false, error };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const info = await smtp.transporter.sendMail({
        from: smtp.from,
        to: recipients.join(', '),
        subject: message.subject,
        html: message.html || undefined,
        text: message.text || undefined,
        replyTo: replyTo || undefined
      });
      await markDelivery(ref, {
        success: true,
        sentAt: FieldValue.serverTimestamp(),
        messageId: info.messageId || null,
        attempts: attempt,
        processedBy: 'processMailQueue',
        info: { accepted: info.accepted, response: info.response }
      });
      await writeMailLog({
        ticketId: mailId,
        mailId,
        condominioId,
        to: recipients.join(', '),
        success: true,
        messageId: info.messageId,
        attempts: attempt
      });
      console.log(`[processMailQueue] OK ${mailId} → ${recipients.join(', ')} (intento ${attempt})`);
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      lastError = err.message || String(err);
      console.warn(`[processMailQueue] ${mailId} intento ${attempt}/${MAX_SEND_ATTEMPTS}:`, lastError);
      if (attempt < MAX_SEND_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  await markDelivery(ref, {
    success: false,
    error: lastError,
    attempts: MAX_SEND_ATTEMPTS,
    processedBy: 'processMailQueue'
  });
  await writeMailLog({
    ticketId: mailId,
    mailId,
    condominioId,
    to: recipients.join(', '),
    success: false,
    error: lastError,
    attempts: MAX_SEND_ATTEMPTS
  });
  return { ok: false, error: lastError };
}

async function ensureMailQueued({ recipients, email, ticketId, condominioId, source, ticket }) {
  const mailRef = db().collection('mail').doc(ticketId);
  const snap = await mailRef.get();
  if (snap.exists()) {
    console.log(`[ensureMailQueued] mail/${ticketId} ya existe (${source})`);
    return ticketId;
  }
  await mailRef.set({
    to: recipients.length === 1 ? recipients[0] : recipients,
    replyTo: email.replyTo,
    message: { subject: email.subject, html: email.html, text: email.text },
    meta: {
      tipo: 'ticket_created',
      ticketId,
      condominioId,
      source: source || 'function',
      database: FIRESTORE_DATABASE_ID.value(),
      createdAt: FieldValue.serverTimestamp(),
      ticketSnapshot: ticket ? {
        nombre: ticket.nombre || '',
        departamento: ticket.departamento || '',
        email: ticket.email || '',
        categoria: ticket.categoria || ''
      } : null
    }
  });
  return ticketId;
}

/** Función 1: mail/{mailId} → SMTP + delivery + logs */
exports.processMailQueue = onDocumentCreated(
  {
    document: 'mail/{mailId}',
    database: FIRESTORE_DATABASE_ID,
    region: 'us-central1',
    retry: true
  },
  async (event) => {
    const mailId = event.params.mailId;
    const data = event.data?.data();
    if (!data?.message?.subject) {
      console.warn(`[processMailQueue] ${mailId} sin message.subject`);
      return;
    }
    if (isAlreadySent(data)) return;

    const ref = event.data.ref;
    const claim = await tryClaimMailDelivery(ref, 'processMailQueue');
    if (!claim.claimed) {
      console.log(`[processMailQueue] ${mailId} skip (${claim.reason})`);
      return;
    }

    const condominioId = data.meta?.condominioId || 'hipodromo';
    const recipients = normalizeMailRecipients(data.to);
    if (!recipients.length) {
      await markDelivery(ref, { success: false, error: 'Falta campo to', processedBy: 'processMailQueue' });
      await writeMailLog({ ticketId: mailId, mailId, success: false, error: 'Falta campo to' });
      return;
    }

    let settings = {};
    try {
      const snap = await db().doc(`condominios/${condominioId}/settings/main`).get();
      if (snap.exists()) settings = snap.data();
    } catch (err) {
      console.warn('[processMailQueue] settings:', err.message);
    }

    await sendMailWithRetries({
      ref,
      mailId,
      condominioId,
      recipients,
      message: data.message,
      replyTo: data.replyTo,
      settings
    });
  }
);

/** Función 2: tickets/{ticketId} → crea mail/{ticketId} */
exports.notifyAdminOnTicket = onDocumentCreated(
  {
    document: 'condominios/{condominioId}/tickets/{ticketId}',
    database: FIRESTORE_DATABASE_ID,
    region: 'us-central1',
    retry: true
  },
  async (event) => {
    const ticket = event.data?.data();
    if (!ticket) return;

    const { condominioId, ticketId } = event.params;
    console.log(`[notifyAdminOnTicket] ${ticketId} db=${FIRESTORE_DATABASE_ID.value()}`);

    const settingsSnap = await db().doc(`condominios/${condominioId}/settings/main`).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const recipients = await resolveRecipients(settings, condominioId);

    if (!recipients.length) {
      console.error(`[notifyAdminOnTicket] Sin notifyAdminEmail (${condominioId})`);
      return;
    }

    const email = buildTicketEmail({ ticketId, condominioId, ticket, settings });
    email.replyTo = parseEmails(ticket.email)[0] || undefined;

    const mailId = await ensureMailQueued({
      recipients,
      email,
      ticketId,
      condominioId,
      source: 'notifyAdminOnTicket',
      ticket
    });
    console.log(`[notifyAdminOnTicket] mail/${mailId} → processMailQueue`);
  }
);
