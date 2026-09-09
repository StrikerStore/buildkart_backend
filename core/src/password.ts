import bcrypt from 'bcryptjs';

/**
 * bcrypt at cost 12.
 *
 * Chosen over argon2 because bcryptjs is pure JavaScript: there is no native
 * binary to fail a Railway Nixpacks build, which is a real failure mode and a
 * miserable one to debug. A single owner logging in once a day does not need
 * argon2's memory-hardness margin.
 */
const COST = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Burns roughly the same time as a real comparison when the account does not
 * exist, so response timing cannot be used to enumerate valid admin emails.
 */
export async function fakePasswordCompare(): Promise<void> {
  await bcrypt.compare(
    'timing-equalisation',
    '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7QQvBQ0Rm5Y3.qvNMMBOL5nCVjrjLJq',
  );
}
