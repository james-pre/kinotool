import * as z from 'zod';

export const MediaType = z.literal(['movie', 'tv']);
export type MediaType = z.infer<typeof MediaType>;

export const NameInfo = z.object({
	title: z.string(),
	year: z.int().positive().optional(),
	episode: z.int().positive().optional(),
	season: z.int().positive().optional(),
});
export interface NameInfo extends z.infer<typeof NameInfo> {}
