#!/usr/bin/env node

function usage() {
  console.error("Usage: MATRIX_PASSWORD=... bun ./scripts/matrix-login.mjs --homeserver https://matrix.org --user @bot:matrix.org [--device-name Sandy]");
}

function parseArgs(argv) {
  const args = {
    homeserver: null,
    user: null,
    deviceName: "Sandy",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--homeserver":
        args.homeserver = argv[++index] ?? null;
        break;
      case "--user":
        args.user = argv[++index] ?? null;
        break;
      case "--device-name":
        args.deviceName = argv[++index] ?? args.deviceName;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.homeserver || !args.user) {
    throw new Error("Missing required arguments.");
  }

  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    const password = process.env.MATRIX_PASSWORD;
    if (!password) {
      throw new Error("MATRIX_PASSWORD is required.");
    }

    const response = await fetch(new URL("/_matrix/client/v3/login", args.homeserver), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: args.user,
        },
        password,
        initial_device_display_name: args.deviceName,
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(typeof body?.error === "string" ? body.error : `Matrix login failed with HTTP ${response.status}.`);
    }

    if (typeof body?.access_token !== "string" || typeof body?.device_id !== "string" || typeof body?.user_id !== "string") {
      throw new Error("Matrix login response did not contain access_token, device_id, and user_id.");
    }

    console.log(JSON.stringify({
      user_id: body.user_id,
      device_id: body.device_id,
      access_token: body.access_token,
    }, null, 2));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
