const { Resend } = require('resend');

let resend;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

/**
 * Formats and sends a Grafana alert notification via Resend HTTPS API
 * @param {Object} alertPayload - The webhook payload sent from Grafana
 * @param {string[]} [customRecipients] - Optional array of recipient emails
 */
async function sendAlertEmail(alertPayload, customRecipients = null) {
  if (!resend) {
    if (process.env.RESEND_API_KEY) {
      resend = new Resend(process.env.RESEND_API_KEY);
    } else {
      throw new Error('RESEND_API_KEY is not defined in environment');
    }
  }

  const status = (alertPayload.status || alertPayload.state || 'firing').toLowerCase();
  const isFiring = status === 'firing' || status === 'alerting';
  const statusColor = isFiring ? '#EF4444' : '#10B981';
  const statusBadge = isFiring ? '🚨 ALERT FIRING' : '✅ RESOLVED';

  const title =
    alertPayload.title ||
    alertPayload.commonAnnotations?.summary ||
    alertPayload.alerts?.[0]?.annotations?.summary ||
    'Cocpit Service Alert';
  const description =
    alertPayload.message ||
    alertPayload.commonAnnotations?.description ||
    alertPayload.alerts?.[0]?.annotations?.description ||
    'An alert threshold condition has been triggered.';

  let recipients;
  if (customRecipients && customRecipients.length > 0) {
    recipients = customRecipients;
  } else if (process.env.ALERT_EMAIL_RECIPIENTS) {
    recipients = process.env.ALERT_EMAIL_RECIPIENTS.split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  } else {
    recipients = ['developer@cocpit.in'];
  }

  const alertItems = (alertPayload.alerts || [])
    .map((a) => {
      const s = a.annotations?.summary || a.labels?.alertname || 'Alert';
      const d = a.annotations?.description || '';
      const sev = a.labels?.severity || 'warning';
      const time = a.startsAt
        ? new Date(a.startsAt).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
          })
        : new Date().toLocaleString();
      return `
      <div style="border-left: 4px solid ${statusColor}; padding: 8px 12px; margin-bottom: 8px; background: #f9fafb; border-radius: 4px;">
        <div style="font-weight: bold; font-size: 14px; color: #111827;">${s} (${sev.toUpperCase()})</div>
        <div style="font-size: 13px; color: #4b5563; margin-top: 2px;">${d}</div>
        <div style="font-size: 11px; color: #9ca3af; margin-top: 4px;">Triggered: ${time} IST</div>
      </div>
    `;
    })
    .join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"/></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 24px;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border: 1px solid #e5e7eb;">
        <div style="background: ${statusColor}; padding: 16px 24px;">
          <span style="background: rgba(255,255,255,0.25); color: #ffffff; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; letter-spacing: 0.5px;">${statusBadge}</span>
          <h1 style="color: #ffffff; margin: 12px 0 0 0; font-size: 20px; font-weight: 600;">${title}</h1>
        </div>
        <div style="padding: 24px;">
          <p style="color: #374151; font-size: 15px; margin-top: 0; line-height: 1.5;">${description}</p>
          
          ${alertItems ? `<div style="margin: 20px 0;">${alertItems}</div>` : ''}

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin: 20px 0; font-size: 13px; color: #4b5563;">
            <strong>Environment:</strong> UAT<br/>
            <strong>Project:</strong> cocpit-web<br/>
            <strong>Monitoring:</strong> Prometheus & Grafana
          </div>

          <div style="margin-top: 24px; text-align: center;">
            <a href="${process.env.GRAFANA_DASHBOARD_URL || 'http://13.204.208.191/grafana/d/amnnmv/cocpit-uat-api-and-performance-observability'}" style="background: #111827; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; display: inline-block;">View Grafana Observability Dashboard</a>
          </div>
        </div>
        <div style="background: #f9fafb; padding: 12px 24px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb;">
          Sent by Cocpit Automated Alerting • noreply@cocpit.in
        </div>
      </div>
    </body>
    </html>
  `;

  const { data, error } = await resend.emails.send({
    from: 'Cocpit Alerts <noreply@cocpit.in>',
    to: recipients,
    subject: `[${status.toUpperCase()}] ${title} - Cocpit UAT`,
    html,
  });

  if (error) {
    console.error('Resend alert email error:', error);
    throw error;
  }

  console.log(
    `[Resend Alert] Successfully sent alert email (${data.id}) to:`,
    recipients.join(', ')
  );
  return data;
}

module.exports = { sendAlertEmail };
