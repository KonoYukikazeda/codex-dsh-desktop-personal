import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(authorization, expectedToken) {
  if (expectedToken === undefined || expectedToken === null || expectedToken === '') return true;
  if (typeof expectedToken !== 'string') return false;
  if (typeof authorization !== 'string') return false;

  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization);
  if (!match) return false;

  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
