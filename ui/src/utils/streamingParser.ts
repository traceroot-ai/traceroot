/**
 * Utility functions for parsing streaming JSON content in the frontend
 */

/**
 * Extract clean answer content from streaming JSON chunks
 * @param content Raw content from streaming response
 * @returns Clean answer content without JSON formatting
 */
export function extractAnswerContent(content: string): string {
  if (!content) return content;

  let cleanContent = content;

  // Handle {"answer": "content"} format
  if (cleanContent.includes('{"answer":"')) {
    const answerStart =
      cleanContent.indexOf('{"answer":"') + '{"answer":"'.length;
    cleanContent = cleanContent.substring(answerStart);
  }
  // Handle "answer": "content" format (with potential spaces)
  else if (cleanContent.includes('"answer":"')) {
    const answerStart =
      cleanContent.indexOf('"answer":"') + '"answer":"'.length;
    cleanContent = cleanContent.substring(answerStart);
  }
  // Handle "answer" : "content" format (with spaces around colon)
  else if (cleanContent.includes('"answer" :')) {
    const answerStart =
      cleanContent.indexOf('"answer" :') + '"answer" :'.length;
    // Skip spaces and quotes after colon
    cleanContent = cleanContent.substring(answerStart).replace(/^\s*"/, "");
  }

  // Remove reference section if it exists
  if (cleanContent.includes('","reference"')) {
    const referenceStart = cleanContent.indexOf('","reference"');
    cleanContent = cleanContent.substring(0, referenceStart);
  }
  // Handle ", "reference" format (with space)
  else if (cleanContent.includes('", "reference"')) {
    const referenceStart = cleanContent.indexOf('", "reference"');
    cleanContent = cleanContent.substring(0, referenceStart);
  }
  // Handle "reference" at the end
  else if (cleanContent.includes('"reference"')) {
    const referenceStart = cleanContent.indexOf('"reference"');
    cleanContent = cleanContent.substring(0, referenceStart);
  }

  return cleanContent;
}

/**
 * Process multiple reasoning chunks and combine them into clean content
 * @param chunks Array of reasoning content chunks
 * @returns Combined clean content
 */
export function processReasoningChunks(chunks: string[]): string {
  return chunks
    .map((chunk) => extractAnswerContent(chunk))
    .filter((content) => content.trim().length > 0)
    .join("");
}
