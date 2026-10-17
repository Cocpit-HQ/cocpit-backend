/**
 * SMS Service
 * Wraps Twilio Verify API for multi-channel phone OTP.
 * Supports mock fallback if Twilio credentials are not set.
 */

let twilioClient;
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const serviceSid = process.env.TWILIO_SERVICE_SID;

if (accountSid && authToken && serviceSid) {
  try {
    const twilio = require("twilio");
    twilioClient = twilio(accountSid, authToken);
    console.log("✅ Twilio SMS client initialized");
  } catch (err) {
    console.warn("⚠️ Failed to load twilio package. SMS service will run in MOCK mode.", err.message);
  }
} else {
  console.warn("⚠️ Twilio credentials missing in environment. SMS service will run in MOCK mode.");
}

const defaultCountryCode = process.env.DEFAULT_SMS_COUNTRY_CODE || "+91";
const countryDialCodes = {
  "India": "+91",
  "United Arab Emirates": "+971",
  "Singapore": "+65"
};

/**
 * Normalizes a phone number to E.164 format.
 * If already E.164 (starts with +), keeps it.
 * Otherwise, uses the provided country name to determine the correct dial code,
 * falling back to process.env.DEFAULT_SMS_COUNTRY_CODE or "+91".
 * @param {string} phone
 * @param {string} [country]
 * @returns {string} E.164 formatted phone number
 */
function normalizePhone(phone, country) {
  if (!phone) return phone;
  
  // Trim spaces and remove common punctuation/formatting characters
  let cleaned = phone.trim().replace(/[\s\-()]/g, "");

  // If already starts with "+", it's in E.164 format
  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, "");

  // Look up country dial code
  const selectedCode = (country && countryDialCodes[country]) || defaultCountryCode;
  const formattedCode = selectedCode.startsWith("+") ? selectedCode : `+${selectedCode}`;
  const rawCode = formattedCode.replace("+", "");

  // If the number starts with the country's dial code (without "+"), just prepend "+"
  if (cleaned.startsWith(rawCode)) {
    return `+${cleaned}`;
  }

  // Otherwise, prepend the country dial code
  return `${formattedCode}${cleaned}`;
}

exports.normalizePhone = normalizePhone;


exports.sendSMSOTP = async (phone, otp, country) => {
  const normalizedPhone = normalizePhone(phone, country);
  if (twilioClient && serviceSid) {
    try {
      // Using Twilio Verify API (no need to store OTP ourselves, Twilio manages it)
      // Note: In a production setup, Twilio Verify creates and sends the code.
      // We will request a verification code from Twilio.
      const verification = await twilioClient.verify.v2
        .services(serviceSid)
        .verifications.create({ to: normalizedPhone, channel: "sms" });
      return { success: true, sid: verification.sid };
    } catch (err) {
      console.error("Twilio send error, falling back to mock:", err);
      // Fallback to mock on error
    }
  }

  // Mock Fallback
  console.log(`[SMS VERIFICATION MOCK] OTP for ${normalizedPhone}: ${otp}`);
  return { success: true, mock: true };
};

/**
 * Checks/Verifies the code submitted by the user.
 * @param {string} phone - Target phone number
 * @param {string} otp - User-submitted OTP code
 * @param {string} expectedOtp - Expected OTP from local DB (for Mock mode)
 * @param {string} [country] - Organization's country
 * @returns {Promise<boolean>} True if valid
 */
exports.verifySMSOTP = async (phone, otp, expectedOtp, country) => {
  const normalizedPhone = normalizePhone(phone, country);
  if (twilioClient && serviceSid) {
    try {
      const check = await twilioClient.verify.v2
        .services(serviceSid)
        .verificationChecks.create({ to: normalizedPhone, code: otp });
      return check.status === "approved";
    } catch (err) {
      console.error("Twilio verification check error, falling back to local DB check:", err);
    }
  }

  // Mock or Local DB verification fallback
  return otp === expectedOtp;
};
