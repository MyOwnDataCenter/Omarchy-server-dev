import {query} from '../api.ts'

import type {Stats} from './api.ts'

// One machine's chart history only: asking for every machine sends up to 360 points for each of them every poll.
export const statsQueryKey = (id: string) => ['machines.stats', id] as const
export const fetchStats = (id: string) => query<Stats>('machines.stats', {id})
