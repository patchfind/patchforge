import { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { config } from './config.js';
import type { PatchTask } from './types.js';
import { SAVED_AGENT_INSTRUCTIONS, buildInstructions } from './prompts.js';

export const trueforge = new TrueForge({
  baseUrl: config.trueforge.baseUrl,
  // Passing `auth: false` rather than an empty token keeps the client from
  // sending `Authorization: Bearer` with nothing behind it, which an
  // OIDC-enabled server would reject outright.
  ...(config.trueforge.apiKey
    ? { token: config.trueforge.apiKey }
    : { auth: false as const }),
});

/**
 * Inline agent spec bound to the Plane 1 registry assets.
 *
 * The approval gate is declared here, not implemented here: TrueForge pauses
 * the turn and emits `tool.approval_required` for any tool listed in
 * `requireApprovalForTools`. Restricting it to `create_pull_request` alone
 * (rather than the `["@write","@destructive"]` default) is deliberate — the
 * agent must be free to push commits to its own working branch without a human
 * in the loop, and be stopped only at the point the change becomes a proposal.
 */
export function buildAgentSpec(
  task: PatchTask,
  skillName: string | null,
): TrueForgeApi.AgentSpec {
  const skills = skillName ? [{ name: skillName }] : [];

  return {
    model: {
      name: config.model,
      params: { temperature: 0.1 },
    },
    instructions: buildInstructions(task, skillName),
    skills,
    mcpServers: [
      {
        name: config.mcpServerName,
        enableTools: ['@all'],
        requireApprovalForTools: [config.approvalGateTool],
        // The tool set is small and every run uses it; loading schemas upfront
        // avoids a discovery round-trip per session.
        preload: true,
      },
    ],
    config: {
      // Skills are mounted into the sandbox filesystem, so it must be enabled.
      sandbox: { enabled: true, fileDownloads: true },
      contextManagement: {
        compaction: {
          enabled: true,
          compactionThresholdTokens: config.compactionThresholdTokens,
        },
      },
      dynamicSubAgents: { enabled: true },
      iterationLimit: config.iterationLimit,
    },
  };
}

export async function createSession(task: PatchTask, skillName: string | null) {
  // A saved agent is referenced by name; the inline spec is sent whole. Both
  // produce the same session shape, so nothing downstream changes.
  const agent = config.savedAgentName
    ? { name: config.savedAgentName }
    : { spec: buildAgentSpec(task, skillName) };

  const res = await trueforge.sessions.create({ agent });
  return res.data;
}

/** Skills configured in Plane 1. The saved agent advertises all of them. */
export async function listConfiguredSkillNames(): Promise<string[]> {
  const res = await trueforge.skills.list();
  return res.data.map((s) => s.name);
}

/**
 * Create (or update) the reusable agent in the TrueForge Agents Library.
 *
 * This is the API behind "Save Agent" in the UI. Registering it makes the same
 * orchestrator selectable from TrueForge chat, not only from this worker.
 *
 * Every registered skill is attached, because a saved agent cannot be scoped
 * per task — the model chooses using each skill's description.
 */
export async function registerSavedAgent(
  name: string,
  skillNames: string[],
): Promise<{ created: boolean; id: string }> {
  const manifest: TrueForgeApi.AgentSpec = {
    ...buildAgentSpec(
      {
        repo_url: '',
        target_package: '',
        current_version: '',
        vulnerabilities: [],
      } as unknown as PatchTask,
      null,
    ),
    instructions: SAVED_AGENT_INSTRUCTIONS,
    skills: skillNames.map((n) => ({ name: n })),
  };

  const existing = await trueforge.agents.list();
  const match = existing.data.find((a) => a.name === name);

  if (match) {
    const res = await trueforge.agents.update(match.id, { manifest });
    return { created: false, id: res.data.id };
  }
  const res = await trueforge.agents.create({ name, manifest });
  return { created: true, id: res.data.id };
}

/**
 * Verify Plane 1 is actually configured before consuming any task. Failing here
 * at boot is far cheaper than failing halfway through an agent run.
 */
export async function preflight(): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  try {
    const models = await trueforge.models.list();
    const names = models.data.map((m) => m.name);
    if (names.length && !names.includes(config.model)) {
      problems.push(
        `model "${config.model}" is not registered (available: ${names.join(', ') || 'none'})`,
      );
    }
  } catch (err: any) {
    problems.push(`cannot list models: ${err?.message ?? err}`);
  }

  try {
    const servers = await trueforge.mcpServers.list();
    const names = servers.data.map((s) => s.name);
    if (names.length && !names.includes(config.mcpServerName)) {
      problems.push(
        `MCP server "${config.mcpServerName}" is not configured (available: ${names.join(', ') || 'none'})`,
      );
    }
  } catch (err: any) {
    problems.push(`cannot list MCP servers: ${err?.message ?? err}`);
  }

  try {
    const skills = await trueforge.skills.list();
    const names = skills.data.map((s) => s.name);
    console.log(`[preflight] skills registered: ${names.join(', ') || 'none'}`);
  } catch (err: any) {
    problems.push(`cannot list skills: ${err?.message ?? err}`);
  }

  return { ok: problems.length === 0, problems };
}
