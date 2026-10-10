import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export interface SkillMeta {
  name: string
  description: string
}

const FrontmatterSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
})

/** Reads the YAML frontmatter of a SKILL.md (name + description). */
export function parseSkillMarkdown(markdown: string, fallbackName: string): SkillMeta {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  let data: z.infer<typeof FrontmatterSchema> = {}
  if (match?.[1]) {
    try {
      data = FrontmatterSchema.catch({}).parse(parseYaml(match[1]))
    } catch {
      data = {}
    }
  }
  const firstLine = markdown
    .replace(/^---[\s\S]*?---/, '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return {
    name: (data.name ?? fallbackName).trim(),
    description: (data.description ?? firstLine ?? '').trim().slice(0, 500),
  }
}

const PluginManifestSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
})

/** Parses `.claude-plugin/plugin.json`. */
export function parsePluginManifest(
  json: string,
): { name: string; description: string; version: string } | undefined {
  try {
    const data = PluginManifestSchema.parse(JSON.parse(json))
    return { name: data.name, description: data.description ?? '', version: data.version ?? '' }
  } catch {
    return undefined
  }
}

/** Turns any display name into a safe folder name. */
export function toAddonName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 64) || 'addon'
  )
}
