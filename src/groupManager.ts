import * as fs from 'fs';
import type * as vscode from 'vscode';

import {
  GROUP_BROADCAST_DELAY_MS,
  GROUP_BROADCAST_MAX_LENGTH,
  WORKSPACE_KEY_GROUPS,
} from './constants.js';
import type { AgentGroup, AgentState } from './types.js';

/**
 * Manages agent groups for multi-agent collaboration.
 * When an agent completes a turn, its last assistant response
 * is automatically broadcast to other group members via sendText().
 */
export class GroupManager {
  private groups = new Map<string, AgentGroup>();
  private broadcastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.restoreGroups();
  }

  /** Create a new group from selected agent IDs */
  createGroup(name: string, agentIds: number[]): AgentGroup {
    const id = crypto.randomUUID();
    const group: AgentGroup = { id, name, agentIds, enabled: true };
    this.groups.set(id, group);
    this.persistGroups();
    console.log(`[Pixel Agents] Group created: "${name}" with agents [${agentIds.join(', ')}]`);
    return group;
  }

  /** Remove a group by ID */
  removeGroup(groupId: string): void {
    this.groups.delete(groupId);
    this.persistGroups();
  }

  /** Add an agent to an existing group */
  addAgentToGroup(groupId: string, agentId: number): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (!group.agentIds.includes(agentId)) {
      group.agentIds.push(agentId);
      this.persistGroups();
    }
  }

  /** Remove an agent from all groups (e.g., when terminal closes) */
  removeAgentFromAllGroups(agentId: number): void {
    let changed = false;
    for (const group of this.groups.values()) {
      const idx = group.agentIds.indexOf(agentId);
      if (idx !== -1) {
        group.agentIds.splice(idx, 1);
        changed = true;
      }
    }
    // Clean up empty groups
    for (const [id, group] of this.groups) {
      if (group.agentIds.length < 2) {
        this.groups.delete(id);
        changed = true;
      }
    }
    if (changed) this.persistGroups();
  }

  /** Toggle a group's enabled state */
  toggleGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.enabled = !group.enabled;
      this.persistGroups();
    }
  }

  /** Get all groups */
  getGroups(): AgentGroup[] {
    return Array.from(this.groups.values());
  }

  /** Get groups that contain a specific agent */
  getGroupsForAgent(agentId: number): AgentGroup[] {
    return this.getGroups().filter((g) => g.agentIds.includes(agentId));
  }

  /**
   * Called when an agent's turn completes (turn_duration detected).
   * Extracts the last assistant message and broadcasts it to group members.
   */
  onTurnComplete(
    agentId: number,
    agents: Map<number, AgentState>,
    webview: vscode.Webview | undefined,
  ): void {
    const groups = this.getGroupsForAgent(agentId);
    if (groups.length === 0) return;

    // Cancel any pending broadcast for this agent
    const existingTimer = this.broadcastTimers.get(agentId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.broadcastTimers.delete(agentId);
      this.doBroadcast(agentId, agents, groups, webview);
    }, GROUP_BROADCAST_DELAY_MS);
    this.broadcastTimers.set(agentId, timer);
  }

  private doBroadcast(
    sourceAgentId: number,
    agents: Map<number, AgentState>,
    groups: AgentGroup[],
    webview: vscode.Webview | undefined,
  ): void {
    const sourceAgent = agents.get(sourceAgentId);
    if (!sourceAgent) return;

    // Extract last assistant text from the JSONL file
    const lastMessage = this.extractLastAssistantText(sourceAgent.jsonlFile);
    if (!lastMessage) return;

    // Truncate if necessary
    const truncated =
      lastMessage.length > GROUP_BROADCAST_MAX_LENGTH
        ? lastMessage.slice(0, GROUP_BROADCAST_MAX_LENGTH) + '\n...(truncated)'
        : lastMessage;

    // Build the broadcast message
    const terminalName = sourceAgent.terminalRef?.name ?? `Agent ${sourceAgentId}`;
    const broadcastText = `\n[Group Update from ${terminalName}]:\n${truncated}\n`;

    // Collect unique target agent IDs across all groups
    const targetIds = new Set<number>();
    for (const group of groups) {
      if (!group.enabled) continue;
      for (const id of group.agentIds) {
        if (id !== sourceAgentId) {
          targetIds.add(id);
        }
      }
    }

    // Send to each target agent's terminal
    for (const targetId of targetIds) {
      const targetAgent = agents.get(targetId);
      if (!targetAgent?.terminalRef) continue;

      // Only send if target is waiting (not actively running tools)
      if (!targetAgent.isWaiting) {
        console.log(
          `[Pixel Agents] Group broadcast: skipping agent ${targetId} (not waiting for input)`,
        );
        continue;
      }

      console.log(
        `[Pixel Agents] Group broadcast: agent ${sourceAgentId} → agent ${targetId} (${broadcastText.length} chars)`,
      );
      targetAgent.terminalRef.sendText(broadcastText, true);
    }

    // Notify webview about broadcast
    webview?.postMessage({
      type: 'groupBroadcast',
      sourceAgentId,
      targetAgentIds: [...targetIds],
    });
  }

  /** Read the JSONL file backwards to find the last assistant text response */
  private extractLastAssistantText(jsonlFile: string): string | null {
    try {
      if (!fs.existsSync(jsonlFile)) return null;
      const content = fs.readFileSync(jsonlFile, 'utf-8');
      const lines = content.trim().split('\n');

      // Walk backwards to find the last assistant record
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]);
          if (record.type !== 'assistant') continue;

          const msgContent = record.message?.content ?? record.content;
          if (typeof msgContent === 'string') return msgContent;
          if (Array.isArray(msgContent)) {
            // Extract text blocks only
            const texts: string[] = [];
            for (const block of msgContent) {
              if (block.type === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
              }
            }
            if (texts.length > 0) return texts.join('\n');
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error
    }
    return null;
  }

  private persistGroups(): void {
    const groups = this.getGroups();
    this.context.workspaceState.update(WORKSPACE_KEY_GROUPS, groups);
  }

  private restoreGroups(): void {
    const persisted = this.context.workspaceState.get<AgentGroup[]>(WORKSPACE_KEY_GROUPS, []);
    for (const g of persisted) {
      this.groups.set(g.id, g);
    }
  }

  dispose(): void {
    for (const timer of this.broadcastTimers.values()) {
      clearTimeout(timer);
    }
    this.broadcastTimers.clear();
  }
}
