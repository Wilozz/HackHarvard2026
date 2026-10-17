import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const groupSchema = z.object({
  spaceId: z.string(),
  title: z.string().optional(),
  createdAt: z.string(),
  members: z.array(z.object({ name: z.string(), handle: z.string(), userId: z.string() })),
});

export type Group = z.infer<typeof groupSchema>;
export type GroupMember = Group["members"][number];

/**
 * Group chats started from the signup page, with everyone's name. The agent
 * uses it for names and to find where to reply. Holds phone numbers, so the
 * file is gitignored. Without a file it lives in memory only.
 */
export class GroupRegistry {
  private groups: Group[];

  constructor(private readonly file?: string) {
    this.groups = file && existsSync(file) ? z.array(groupSchema).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
  }

  /** Newest first. */
  list(): readonly Group[] {
    return this.groups;
  }

  get(spaceId: string): Group | undefined {
    return this.groups.find((g) => g.spaceId === spaceId);
  }

  /** Add a group, or replace the one with the same Space and move it to the front. */
  upsert(group: Group): void {
    this.groups = [group, ...this.groups.filter((g) => g.spaceId !== group.spaceId)];
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.groups, null, 2)}\n`);
  }

  /** The name someone signed up with, from their newest group. */
  nameOf(userId: string): string | undefined {
    for (const g of this.groups) {
      const member = g.members.find((m) => m.userId === userId);
      if (member) return member.name;
    }
    return undefined;
  }
}
