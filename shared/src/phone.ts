/**
 * Indian mobile numbers, read the way people actually type and paste them.
 *
 * The phone is the customer's identity here, so this has to be both forgiving
 * and exact: forgiving about *formatting* — "+91 98260-12345", "098260 12345",
 * "(98260) 12345", Hindi digits — and exact about the *number*, because a
 * misread one is not a bad field but a second account.
 *
 * The rule that went wrong before: a leading "91" was always taken for the
 * country code. "9174773644" is a perfectly good mobile number that happens to
 * start with 91; stripping it left eight digits and an "invalid number" error.
 * A prefix is removed only when exactly ten digits remain after it.
 */

/** Devanagari ०-९ and full-width ０-９ to ASCII, so a Hindi keyboard just works. */
function asciiDigits(raw: string): string {
  return raw.replace(/[०-९０-９]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0xff10 ? code - 0xff10 : code - 0x0966);
  });
}

/**
 * The ten-digit number in whatever was typed, or the cleaned digits as they
 * are when no prefix can be removed — so a too-short or too-long entry is
 * still shown back, and `indianMobileError` can say what is wrong with it.
 */
export function normalizeIndianMobile(raw: string): string {
  const digits = asciiDigits(raw).replace(/\D/g, '');
  if (digits.length === 10) return digits;
  // Each prefix only when it leaves exactly ten digits behind.
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 13 && digits.startsWith('910')) return digits.slice(3);
  if (digits.length === 14 && digits.startsWith('0091')) return digits.slice(4);
  return digits;
}

/** What is wrong with a typed number, in words a customer can act on; null when it is fine. */
export function indianMobileError(raw: string): string | null {
  const number = normalizeIndianMobile(raw);
  if (number.length === 0) return 'Enter your 10-digit mobile number.';
  if (number.length < 10) {
    return `That is ${number.length} digit${number.length === 1 ? '' : 's'} — a mobile number has 10.`;
  }
  if (number.length > 10) return 'That is more than 10 digits. Enter just the 10-digit mobile number.';
  if (!/^[6-9]/.test(number)) {
    return 'Indian mobile numbers start with 6, 7, 8 or 9. A landline will not get the OTP.';
  }
  // "9999999999" and friends: nothing real, and a sure way to lose an order.
  if (/^(\d)\1{9}$/.test(number)) return 'Enter a real mobile number.';
  return null;
}

export function isValidIndianMobile(raw: string): boolean {
  return indianMobileError(raw) === null;
}

/**
 * For an input's `onChange`: the cleaned number, capped at ten digits once any
 * prefix is gone. A pasted "+91 91747 73644" becomes "9174773644" — never the
 * first ten digits of the paste, which would be "9191747736".
 */
export function mobileInputValue(raw: string): string {
  return normalizeIndianMobile(raw).slice(0, 10);
}
