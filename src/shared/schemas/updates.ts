import { z } from 'zod'

export const UpdateStatusSchema = z.object({
  state: z.enum([
    'disabled',
    'checking',
    'available',
    'downloading',
    'not-available',
    'downloaded',
    'error',
  ]),
  message: z.string(),
  /** Version being downloaded or ready to install. */
  version: z.string().nullable(),
  /** Download progress 0–100 while downloading. */
  percent: z.number().nullable(),
})
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>
