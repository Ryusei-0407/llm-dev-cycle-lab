export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  stream(messages: ChatMessage[]): AsyncIterable<string>;
}
