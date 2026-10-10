import { z } from 'zod'

/** Name used as folder / config key: lowercase letters, digits, dash, underscore, dot. */
export const AddonNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'Nur Buchstaben, Zahlen, Punkt, Binde- und Unterstrich')

export const McpTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Environment variables (values are stored encrypted). */
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
])
export type McpTransport = z.infer<typeof McpTransportSchema>

export const McpServerEntrySchema = z.object({
  name: AddonNameSchema,
  enabled: z.boolean(),
  description: z.string().default(''),
  source: z.enum(['registry', 'manual']),
  /** Registry name, e.g. "io.github.foo/bar". */
  registryName: z.string().optional(),
  transport: McpTransportSchema,
})
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>

/** Same as McpServerEntry but secrets are masked for the renderer. */
export const McpServerViewSchema = McpServerEntrySchema.extend({
  /** Names of env vars / headers that have a value (values are never sent to the UI). */
  secretKeys: z.array(z.string()),
})
export type McpServerView = z.infer<typeof McpServerViewSchema>

export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Folder of the skill (contains SKILL.md). */
  path: z.string(),
  enabled: z.boolean(),
})
export type SkillInfo = z.infer<typeof SkillInfoSchema>

export const PluginInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  path: z.string(),
  enabled: z.boolean(),
})
export type PluginInfo = z.infer<typeof PluginInfoSchema>

export const RegistryEnvVarSchema = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  secret: z.boolean(),
  default: z.string().nullable(),
})

/** A server found in the official MCP registry, reduced to what we can install. */
export const RegistryServerSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  repositoryUrl: z.string().nullable(),
  install: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('npm'), packageName: z.string(), version: z.string() }),
    z.object({ kind: z.literal('pypi'), packageName: z.string(), version: z.string() }),
    z.object({ kind: z.literal('remote'), url: z.string() }),
    z.object({ kind: z.literal('unsupported'), reason: z.string() }),
  ]),
  envVars: z.array(RegistryEnvVarSchema),
})
export type RegistryServer = z.infer<typeof RegistryServerSchema>

/** Something installable found inside a downloaded GitHub repository. */
export const RepoCandidateSchema = z.object({
  kind: z.enum(['skill', 'plugin']),
  name: z.string(),
  description: z.string(),
  /** Folder inside the archive. */
  relPath: z.string(),
})
export type RepoCandidate = z.infer<typeof RepoCandidateSchema>

export const AddonsOverviewSchema = z.object({
  skills: z.array(SkillInfoSchema),
  plugins: z.array(PluginInfoSchema),
  mcpServers: z.array(McpServerViewSchema),
})
export type AddonsOverview = z.infer<typeof AddonsOverviewSchema>
