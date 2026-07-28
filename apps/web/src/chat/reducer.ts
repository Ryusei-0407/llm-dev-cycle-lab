export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatState {
  messages: ChatMessage[];
  status: 'idle' | 'streaming';
  error: string | null;
}

export type ChatAction =
  | { type: 'start'; content: string }
  | { type: 'delta'; delta: string }
  | { type: 'done' }
  | { type: 'stop' }
  | { type: 'error'; message: string };

export const initialState: ChatState = {
  messages: [],
  status: 'idle',
  error: null,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'start':
      return {
        messages: [
          ...state.messages,
          { role: 'user', content: action.content },
          { role: 'assistant', content: '' },
        ],
        status: 'streaming',
        error: null,
      };
    case 'delta': {
      if (state.status !== 'streaming') return state;
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = {
        ...last,
        content: last.content + action.delta,
      };
      return { ...state, messages };
    }
    case 'done':
    case 'stop':
      return { ...state, status: 'idle' };
    case 'error': {
      // Drop a trailing empty assistant bubble, keep partial text if any.
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && last.content === '') messages.pop();
      return { messages, status: 'idle', error: action.message };
    }
  }
}
