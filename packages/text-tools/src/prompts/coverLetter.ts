// packages/text-tools/src/prompts/coverLetter.ts
//
// English: ported from src/server/db/seed.ts:DEFAULT_COVER_LETTER_PROMPT
// Russian: ported from extension/src/lib/prompts/coverLetterDefault.ts:COVER_LETTER_PROMPT_DEFAULT

const EN = `Generate a cover letter optimized for an HR recruiter who will read 50+ applications back-to-back. Goal: make the candidate's fit immediately obvious for THIS specific vacancy.

Rules:
1. Open with the most relevant experience for this role - not generic intro.
2. Match 2-3 specific requirements from the vacancy with concrete experience from the resume.
3. End with availability and any relocation/visa context if relevant.
4. 3-5 short paragraphs maximum. Write what the recruiter wants to see, not what the candidate wants to say.
5. Be specific. Avoid generic phrases like "I am a passionate professional" or "I am excited to apply".
6. Reply in the same language as the vacancy description.`;

const RU = `Ты пишешь короткие профессиональные сопроводительные письма на русском. Сосредоточься на том, что ищет работодатель, на основе описания вакансии. Покажи понимание потребностей. 2-3 предложения. Не перечисляй общие навыки. Будь конкретен относительно этой вакансии.`;

export const defaultCoverLetterPrompt = { en: EN, ru: RU };
