import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const configPath = resolve(process.cwd(), "wrangler.toml");
const databaseName = "keyaos-db";
const bindingName = "DB";

function runWrangler(args) {
	const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const result = spawnSync(command, ["exec", "wrangler", ...args], {
		encoding: "utf8",
		shell: process.platform === "win32",
	});

	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`wrangler ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function getDatabaseBindingBlock(config) {
	const block = config.match(
		/\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[|$)/,
	)?.[0];
	if (!block) throw new Error("No [[d1_databases]] binding found in wrangler.toml.");

	const binding = block.match(/^binding\s*=\s*"([^"]+)"/m)?.[1];
	const name = block.match(/^database_name\s*=\s*"([^"]+)"/m)?.[1];
	const id = block.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];

	if (binding !== bindingName || name !== databaseName) {
		throw new Error(
			`Expected D1 binding ${bindingName} for database ${databaseName}.`,
		);
	}
	return { block, id };
}

function parseDatabaseList(output) {
	const parsed = JSON.parse(output);
	const databases = Array.isArray(parsed) ? parsed : parsed.result;
	if (!Array.isArray(databases)) {
		throw new Error("Unexpected output from wrangler d1 list --json.");
	}
	return databases.find((database) => database.name === databaseName)?.uuid;
}

async function saveDatabaseId(databaseId) {
	if (!/^[\da-f-]{36}$/i.test(databaseId)) {
		throw new Error("Wrangler returned an invalid D1 database ID.");
	}

	const config = await readFile(configPath, "utf8");
	const { block, id } = getDatabaseBindingBlock(config);
	if (id) {
		if (id !== databaseId) {
			throw new Error("wrangler.toml already contains a different D1 database ID.");
		}
		return;
	}

	const updatedBlock = block.replace(
		/^(database_name\s*=\s*"[^"]+")$/m,
		`$1\ndatabase_id = "${databaseId}"`,
	);
	if (updatedBlock === block) {
		throw new Error("Could not add database_id to the D1 binding.");
	}
	await writeFile(configPath, config.replace(block, updatedBlock), "utf8");
}

async function ensureD1Database() {
	const config = await readFile(configPath, "utf8");
	const { id } = getDatabaseBindingBlock(config);
	if (id) {
		console.log(`Using the existing D1 database ID from wrangler.toml.`);
		return;
	}

	let databaseId = parseDatabaseList(
		runWrangler(["d1", "list", "--json"]),
	);
	if (databaseId) {
		console.log(`Found existing D1 database "${databaseName}"; saving its ID.`);
		await saveDatabaseId(databaseId);
		return;
	}

	try {
		runWrangler([
			"d1",
			"create",
			databaseName,
			"--binding",
			bindingName,
			"--update-config",
		]);
	} catch (error) {
		databaseId = parseDatabaseList(
			runWrangler(["d1", "list", "--json"]),
		);
		if (!databaseId) throw error;
		await saveDatabaseId(databaseId);
		return;
	}

	const updatedConfig = await readFile(configPath, "utf8");
	const { id: createdId } = getDatabaseBindingBlock(updatedConfig);
	if (!createdId) {
		throw new Error(
			`Wrangler created "${databaseName}" but did not save its ID to wrangler.toml.`,
		);
	}
	console.log(`Created D1 database "${databaseName}" and saved its ID.`);
}

await ensureD1Database();
