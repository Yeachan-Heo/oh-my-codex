import { readIdentityStatus, switchIdentitySlot } from "../auth/identity.js";

const HELP = `omx identity - Inspect and switch Codex identity slots

Usage:
  omx identity doctor [--json]
  omx identity list [--json]
  omx identity use <slot>
  omx identity policy [--json]
`;

const POLICY = {
  primary: "chatgpt-main",
  api: "allowed-mixed",
  bridge: "open-original",
};

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

export async function identityCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP.trim());
    return;
  }

  if (command === "policy") {
    if (wantsJson(args)) {
      console.log(JSON.stringify(POLICY, null, 2));
      return;
    }
    console.log(`primary=${POLICY.primary}`);
    console.log(`api=${POLICY.api}`);
    console.log(`bridge=${POLICY.bridge}`);
    return;
  }

  if (command === "doctor") {
    const status = await readIdentityStatus();
    if (wantsJson(args)) {
      console.log(JSON.stringify({ ...status, policy: POLICY }, null, 2));
      return;
    }
    console.log(`codexHome: ${status.codexHome}`);
    console.log(`authPath: ${status.authPath}`);
    console.log(`activeKind: ${status.kind}`);
    console.log(`authMode: ${status.authMode ?? "unknown"}`);
    console.log(`currentSlot: ${status.currentSlot ?? "none"}`);
    console.log(`slots: ${status.slots.length}`);
    console.log(`policy: primary=${POLICY.primary} api=${POLICY.api} bridge=${POLICY.bridge}`);
    for (const warning of status.warnings) console.log(`warning: ${warning}`);
    if (status.warnings.length === 0) console.log("warning: none");
    return;
  }

  if (command === "list") {
    const status = await readIdentityStatus();
    if (wantsJson(args)) {
      console.log(JSON.stringify({ slots: status.slots, currentSlot: status.currentSlot }, null, 2));
      return;
    }
    if (status.slots.length === 0) {
      console.log("No identity slots configured. Run `omx auth add <slot>` first.");
      return;
    }
    for (const slot of status.slots) {
      const markers = [
        slot.slot === status.currentSlot ? "current" : "",
        slot.isPrimary ? "primary" : "",
        slot.kind ? `kind=${slot.kind}` : "kind=unknown",
      ].filter(Boolean).join(" ");
      console.log(`${slot.slot}${slot.displayName ? ` (${slot.displayName})` : ""}${markers ? ` [${markers}]` : ""}`);
    }
    return;
  }

  if (command === "use") {
    const slot = args[1];
    if (!slot) throw new Error("Usage: omx identity use <slot>");
    const record = await switchIdentitySlot(slot);
    console.log(`Using identity slot ${record.slot}`);
    return;
  }

  throw new Error(`Unknown identity command: ${command}\n${HELP.trim()}`);
}
