// The user's calendar day as YYYY-MM-DD. Date.toISOString() is UTC, so in
// UTC+8 it reports yesterday until 08:00 and "today's outfit" showed the
// wrong day every morning.
const pad = (n: number) => String(n).padStart(2, "0");

export function localIsoDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
