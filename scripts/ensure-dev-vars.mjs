import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const varsPath = resolve(process.cwd(), ".dev.vars");
const templatePath = new URL("../.dev.vars.example", import.meta.url);

async function ensureDevVars() {
	try {
		await access(varsPath);
		console.log(".dev.vars already exists; keeping the existing configuration.");
		return;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const template = await readFile(templatePath, "utf8");
	if (
		!/^ADMIN_TOKEN=.*$/m.test(template) ||
		!/^ENCRYPTION_KEY=.*$/m.test(template)
	) {
		throw new Error(
			".dev.vars.example must define ADMIN_TOKEN and ENCRYPTION_KEY.",
		);
	}

	const vars = template
		.replace(
			/^ADMIN_TOKEN=.*$/m,
			`ADMIN_TOKEN=${randomBytes(32).toString("base64")}`,
		)
		.replace(
			/^ENCRYPTION_KEY=.*$/m,
			`ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
		);

	try {
		await writeFile(varsPath, vars, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		console.log("Created .dev.vars with fresh local secrets.");
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		console.log(".dev.vars was created by another process; keeping it.");
	}
}

await ensureDevVars();
