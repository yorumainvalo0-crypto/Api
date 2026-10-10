import { z } from 'zod'
import {
  AddonNameSchema,
  AddonsOverviewSchema,
  McpServerEntrySchema,
  RegistryServerSchema,
  RepoCandidateSchema,
} from './schemas/addons'

const Ok = z.object({ ok: z.boolean() })
const NameInput = z.object({ name: z.string().min(1) })

/** IPC channels for skills, plugins and MCP servers. Merged into the main contract in ./ipc.ts. */
export const addonsContract = {
  'addons:overview': { input: z.void(), output: AddonsOverviewSchema },
  /** Downloads a GitHub repository and lists the skills/plugins in it. */
  'addons:repo-scan': {
    input: z.object({ repo: z.string().min(3) }),
    output: z.object({
      token: z.string(),
      label: z.string(),
      candidates: z.array(RepoCandidateSchema),
    }),
  },
  'addons:repo-install': {
    input: z.object({ token: z.string(), relPaths: z.array(z.string()).min(1) }),
    output: z.object({ installed: z.array(z.string()), errors: z.array(z.string()) }),
  },
  /** Opens a folder picker and installs the chosen skill/plugin folder. */
  'addons:install-folder': {
    input: z.void(),
    output: z.object({ installed: z.string().nullable() }),
  },
  'addons:skill-read': { input: NameInput, output: z.object({ content: z.string() }) },
  'addons:skill-toggle': { input: NameInput.extend({ enabled: z.boolean() }), output: Ok },
  'addons:skill-remove': { input: NameInput, output: Ok },
  'addons:plugin-toggle': { input: NameInput.extend({ enabled: z.boolean() }), output: Ok },
  'addons:plugin-remove': { input: NameInput, output: Ok },
  'addons:registry-search': {
    input: z.object({ query: z.string() }),
    output: z.array(RegistryServerSchema),
  },
  'addons:registry-install': {
    input: z.object({ server: RegistryServerSchema, env: z.record(z.string(), z.string()) }),
    output: z.object({ name: z.string() }),
  },
  /** Adds or updates a server; empty secret values keep the stored ones. */
  'addons:mcp-save': { input: McpServerEntrySchema, output: Ok },
  'addons:mcp-toggle': {
    input: z.object({ name: AddonNameSchema, enabled: z.boolean() }),
    output: Ok,
  },
  'addons:mcp-remove': { input: z.object({ name: AddonNameSchema }), output: Ok },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>
