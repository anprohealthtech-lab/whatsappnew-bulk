import { queryClient } from '../db';
import { AutomaticReplyGuard } from './guard';

export const automaticReplyGuard = new AutomaticReplyGuard({
  query: async (text, params = []) => Array.from(await queryClient.unsafe(text, params)),
  transaction: async fn => {
    const result: any = await queryClient.begin(async tx => fn(async (text, params = []) => Array.from(await tx.unsafe(text, params))));
    return result;
  },
});
