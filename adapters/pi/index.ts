// cohand — pi adapter entry.
// One job: on session start, open a cohand session (named pi-<folder>) and register the
// browser_* tools; on shutdown, end it. Everything else lives in the cohand daemon.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClient, openPiSession } from "./client.mjs";
import { TOOLS, validateArgs } from "./tools.mjs";

type AnySchema = ReturnType<typeof Type.Object>;

function schemaFor(def: (typeof TOOLS)[number]): AnySchema {
	const props: Record<string, unknown> = {};
	const required: string[] = [];
	for (const a of def.args) {
		const opts = a.description ? { description: a.description } : {};
		if (a.enum) {
			props[a.name] = Type.Unsafe({ type: "string", enum: a.enum, ...opts });
		} else if (a.type === "number") {
			props[a.name] = Type.Number(opts);
		} else if (a.type === "boolean") {
			props[a.name] = Type.Boolean(opts);
		} else {
			props[a.name] = Type.String(opts);
		}
		if (a.required) required.push(a.name);
	}
	return Type.Object(props, required.length ? { required } : {}) as AnySchema;
}

export default function (pi: ExtensionAPI) {
	const client = createClient();
	let unavailable: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		try {
			await openPiSession(client, (ctx as { cwd?: string }).cwd ?? process.cwd());
		} catch (err) {
			unavailable = (err as Error).message;
			ctx.ui.notify(`cohand: ${unavailable}`, "warn");
		}

		for (const def of TOOLS) {
			pi.registerTool({
				name: def.name,
				label: def.name.replace(/^browser_/, ""),
				description: def.description,
				namespace: {
					name: "browser",
					description: "Control the user's real Chrome through cohand (own tab group per pi session)",
				},
				parameters: schemaFor(def),
				async execute(_toolCallId, params) {
					const args = validateArgs(def.name, params as Record<string, unknown>);
					if (!client.session && def.name !== "browser_status") {
						try {
							await openPiSession(client, process.cwd());
							unavailable = null;
						} catch (err) {
							throw new Error(unavailable ?? (err as Error).message);
						}
					}
					const out = await def.run(client, args);
					return {
						content: [{ type: "text", text: out.content }],
						details: out.structured ?? undefined,
					};
				},
			});
		}
	});

	pi.on("session_shutdown", async () => {
		await client.endSession();
	});
}
