// Prints a password hash for HW_PASSWORD_HASH. The password is typed without echo (or piped on stdin).
//   node ui/scripts/hash-password.mjs
import readline from "node:readline";
import { hashPassword } from "../lib/login.mjs";

async function ask(q) {
  if (!process.stdin.isTTY) { let s = ""; for await (const c of process.stdin) s += c; return s.split("\n")[0]; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.startsWith(q)) process.stdout.write(q); };
  const a = await new Promise((r) => rl.question(q, r));
  rl.close(); process.stdout.write("\n");
  return a;
}

const pw = await ask("Password: ");
if (pw.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
if (process.stdin.isTTY && (await ask("Again: ")) !== pw) { console.error("They don't match."); process.exit(1); }
console.log(hashPassword(pw));
