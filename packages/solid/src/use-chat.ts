import type {
  ChatRequest,
  ChatRequestOptions,
  CreateMessage,
  IdGenerator,
  JSONValue,
  Message,
  UseChatOptions as SharedUseChatOptions,
} from '@ai-sdk/ui-utils';
import {
  callChatApi,
  generateId as generateIdFunc,
  processChatStream,
} from '@ai-sdk/ui-utils';
import {
  Accessor,
  JSX,
  Resource,
  Setter,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
} from 'solid-js';
import { useSWRStore } from 'solid-swr-store';
import { createSWRStore } from 'swr-store';

export type { CreateMessage, Message };

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Resource<Message[]>;
  /** The error object of the API request */
  error: Accessor<undefined | Error>;
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   * @param options Additional options to pass to the API call
   */
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: (
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void;
  /**
   * Update the `messages` state locally. This is useful when you want to
   * edit the messages on the client, and then trigger the `reload` method
   * manually to regenerate the AI response.
   */
  setMessages: (messages: Message[]) => void;
  /** The current value of the input */
  input: Accessor<string>;
  /** Signal setter to update the input value */
  setInput: Setter<string>;
  /** An input/textarea-ready onChange handler to control the value of the input */
  handleInputChange: JSX.ChangeEventHandlerUnion<
    HTMLInputElement | HTMLTextAreaElement,
    Event
  >;
  /** Form submission handler to automatically reset input and append a user message */
  handleSubmit: (
    e: Parameters<JSX.EventHandler<HTMLFormElement, SubmitEvent>>[0],
    chatRequestOptions?: ChatRequestOptions,
  ) => void;
  /** Whether the API request is in progress */
  isLoading: Accessor<boolean>;
  /** Additional data added on the server via StreamData */
  data: Accessor<JSONValue[] | undefined>;
};

const getStreamedResponse = async (
  api: string,
  chatRequest: ChatRequest,
  mutate: (data: Message[]) => void,
  setStreamData: Setter<JSONValue[] | undefined>,
  streamData: Accessor<JSONValue[] | undefined>,
  extraMetadata: any,
  messagesRef: Message[],
  abortController: AbortController | null,
  generateId: IdGenerator,
  streamMode?: 'stream-data' | 'text',
  onFinish?: UseChatOptions['onFinish'],
  onResponse?: UseChatOptions['onResponse'],
  onToolCall?: UseChatOptions['onToolCall'],
  sendExtraMessageFields?: boolean,
) => {
  // Do an optimistic update to the chat state to show the updated messages
  // immediately.
  const previousMessages = messagesRef;
  mutate(chatRequest.messages);

  const constructedMessagesPayload = sendExtraMessageFields
    ? chatRequest.messages
    : chatRequest.messages.map(
        ({ role, content, name, data, annotations, toolInvocations }) => ({
          role,
          content,
          ...(name !== undefined && { name }),
          ...(data !== undefined && { data }),
          ...(annotations !== undefined && { annotations }),
          ...(toolInvocations !== undefined && { toolInvocations }),
        }),
      );

  return await callChatApi({
    api,
    messages: constructedMessagesPayload,
    body: {
      data: chatRequest.data,
      ...extraMetadata.body,
      ...chatRequest.options?.body,
    },
    streamMode,
    credentials: extraMetadata.credentials,
    headers: {
      ...extraMetadata.headers,
      ...chatRequest.options?.headers,
    },
    abortController: () => abortController,
    restoreMessagesOnFailure() {
      mutate(previousMessages);
    },
    onResponse,
    onUpdate(merged, data) {
      mutate([...chatRequest.messages, ...merged]);
      setStreamData([...(streamData() || []), ...(data ?? [])]);
    },
    onToolCall,
    onFinish,
    generateId,
  });
};

const store: Record<string, Message[] | undefined> = {};
const chatApiStore = createSWRStore<Message[], string[]>({
  get: async (key: string) => {
    return store[key] ?? [];
  },
});

export type UseChatOptions = Omit<SharedUseChatOptions, 'api'> & {
  api?: string;

  /**
Maximal number of automatic roundtrips for tool calls.

An automatic tool call roundtrip is a call to the server with the 
tool call results when all tool calls in the last assistant 
message have results.

A maximum number is required to prevent infinite loops in the
case of misconfigured tools.

By default, it's set to 0, which will disable the feature.
 */
  maxToolRoundtrips?: number;
};

export function useChat(
  rawUseChatOptions: UseChatOptions | Accessor<UseChatOptions> = {},
): UseChatHelpers & {
  addToolResult: ({
    toolCallId,
    result,
  }: {
    toolCallId: string;
    result: any;
  }) => void;
} {
  const useChatOptions = createMemo(() => handleProps(rawUseChatOptions));
  const generateId = createMemo(
    () => useChatOptions().generateId() || generateIdFunc,
  );

  // Generate a unique ID for the chat if not provided.
  const hookId = createUniqueId();
  const idKey = createMemo(() => useChatOptions().id() || `chat-${hookId}`);
  const chatKey = createMemo(() =>
    typeof useChatOptions().api() === 'string'
      ? `${useChatOptions().api()}|${idKey()}|messages`
      : `${idKey()}|messages`,
  );

  // Because of the `initialData` option, the `data` will never be `undefined`:
  const messages = useSWRStore(chatApiStore, () => [chatKey()], {
    initialData: useChatOptions().initialMessages() || [],
  }) as Resource<Message[]>;

  const mutate = (data: Message[]) => {
    store[chatKey()] = data;
    return chatApiStore.mutate([chatKey()], {
      status: 'success',
      data,
    });
  };

  const [error, setError] = createSignal<undefined | Error>(undefined);
  const [streamData, setStreamData] = createSignal<JSONValue[] | undefined>(
    undefined,
  );
  const [isLoading, setIsLoading] = createSignal(false);

  let messagesRef: Message[] = messages() || [];
  createEffect(() => {
    messagesRef = messages() || [];
  });

  let abortController: AbortController | null = null;

  let extraMetadata = {
    credentials: useChatOptions().credentials(),
    headers: useChatOptions().headers(),
    body: useChatOptions().body(),
  };
  createEffect(() => {
    extraMetadata = {
      credentials: useChatOptions().credentials(),
      headers: useChatOptions().headers(),
      body: useChatOptions().body(),
    };
  });

  const triggerRequest = async (chatRequest: ChatRequest) => {
    const messageCount = messagesRef.length;

    try {
      setError(undefined);
      setIsLoading(true);

      abortController = new AbortController();

      await processChatStream({
        getStreamedResponse: () =>
          getStreamedResponse(
            useChatOptions().api() ?? '/api/chat',
            chatRequest,
            mutate,
            setStreamData,
            streamData,
            extraMetadata,
            messagesRef,
            abortController,
            generateId(),
            useChatOptions().streamMode(),
            useChatOptions().onFinish(),
            useChatOptions().onResponse(),
            useChatOptions().onToolCall(),
            useChatOptions().sendExtraMessageFields(),
          ),
        experimental_onFunctionCall:
          useChatOptions().experimental_onFunctionCall(),
        updateChatRequest(newChatRequest) {
          chatRequest = newChatRequest;
        },
        getCurrentMessages: () => messagesRef,
      });

      abortController = null;
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === 'AbortError') {
        abortController = null;
        return null;
      }

      if (useChatOptions().onError() && err instanceof Error) {
        useChatOptions().onError()!(err);
      }

      setError(err as Error);
    } finally {
      setIsLoading(false);
    }

    const maxToolRoundtrips = useChatOptions().maxToolRoundtrips() ?? 0;
    // auto-submit when all tool calls in the last assistant message have results:
    const messages = messagesRef;
    const lastMessage = messages[messages.length - 1];
    if (
      // ensure we actually have new messages (to prevent infinite loops in case of errors):
      messages.length > messageCount &&
      // ensure there is a last message:
      lastMessage != null &&
      // check if the feature is enabled:
      maxToolRoundtrips > 0 &&
      // check that roundtrip is possible:
      isAssistantMessageWithCompletedToolCalls(lastMessage) &&
      // limit the number of automatic roundtrips:
      countTrailingAssistantMessages(messages) <= maxToolRoundtrips
    ) {
      await triggerRequest({ messages });
    }
  };

  const append: UseChatHelpers['append'] = async (
    message,
    { options, data } = {},
  ) => {
    if (!message.id) {
      message.id = generateId()();
    }

    const chatRequest: ChatRequest = {
      messages: messagesRef.concat(message as Message),
      options,
      data,
    };

    return triggerRequest(chatRequest);
  };

  const reload: UseChatHelpers['reload'] = async ({ options } = {}) => {
    if (messagesRef.length === 0) return null;

    // Remove last assistant message and retry last user message.
    const lastMessage = messagesRef[messagesRef.length - 1];
    if (lastMessage.role === 'assistant') {
      const chatRequest: ChatRequest = {
        messages: messagesRef.slice(0, -1),
        options,
      };

      return triggerRequest(chatRequest);
    }

    const chatRequest: ChatRequest = {
      messages: messagesRef,
      options,
    };

    return triggerRequest(chatRequest);
  };

  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const setMessages = (messages: Message[]) => {
    mutate(messages);
    messagesRef = messages;
  };

  const [input, setInput] = createSignal(useChatOptions().initialInput() || '');

  const handleSubmit: UseChatHelpers['handleSubmit'] = (
    e,
    options = {},
    metadata?: Object,
  ) => {
    if (metadata) {
      extraMetadata = {
        ...extraMetadata,
        ...metadata,
      };
    }

    e.preventDefault();
    const inputValue = input();
    if (!inputValue) return;

    append(
      {
        content: inputValue,
        role: 'user',
        createdAt: new Date(),
      },
      options,
    );
    setInput('');
  };

  const handleInputChange: UseChatHelpers['handleInputChange'] = (e: any) => {
    setInput(e.target.value);
  };

  const addToolResult = ({
    toolCallId,
    result,
  }: {
    toolCallId: string;
    result: any;
  }) => {
    const messagesSnapshot = messages() ?? [];

    const updatedMessages = messagesSnapshot.map((message, index, arr) =>
      // update the tool calls in the last assistant message:
      index === arr.length - 1 &&
      message.role === 'assistant' &&
      message.toolInvocations
        ? {
            ...message,
            toolInvocations: message.toolInvocations.map(toolInvocation =>
              toolInvocation.toolCallId === toolCallId
                ? { ...toolInvocation, result }
                : toolInvocation,
            ),
          }
        : message,
    );

    mutate(updatedMessages);

    // auto-submit when all tool calls in the last assistant message have results:
    const lastMessage = updatedMessages[updatedMessages.length - 1];
    if (isAssistantMessageWithCompletedToolCalls(lastMessage)) {
      triggerRequest({ messages: updatedMessages });
    }
  };

  return {
    messages,
    append,
    error,
    reload,
    stop,
    setMessages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    data: streamData,
    addToolResult,
  };
}

/**
Check if the message is an assistant message with completed tool calls. 
The message must have at least one tool invocation and all tool invocations
must have a result.
 */
function isAssistantMessageWithCompletedToolCalls(message: Message) {
  return (
    message.role === 'assistant' &&
    message.toolInvocations &&
    message.toolInvocations.length > 0 &&
    message.toolInvocations.every(toolInvocation => 'result' in toolInvocation)
  );
}

/**
Returns the number of trailing assistant messages in the array.
 */
function countTrailingAssistantMessages(messages: Message[]) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Handle reactive and non-reactive useChatOptions
 */
function handleProps(props: UseChatOptions | Accessor<UseChatOptions>) {
  // Handle reactive and non-reactive useChatOptions
  const id = createMemo(() =>
    typeof props === 'function' ? props().id : props.id,
  );
  const api = createMemo(() =>
    typeof props === 'function' ? props().api : props.api,
  );
  const credentials = createMemo(() =>
    typeof props === 'function' ? props().credentials : props.credentials,
  );
  const headers = createMemo(() =>
    typeof props === 'function' ? props().headers : props.headers,
  );
  const body = createMemo(() =>
    typeof props === 'function' ? props().body : props.body,
  );
  const initialMessages = createMemo(() =>
    typeof props === 'function'
      ? props().initialMessages
      : props.initialMessages,
  );
  const generateId = createMemo(() =>
    typeof props === 'function' ? props().generateId : props.generateId,
  );
  const streamMode = createMemo(() =>
    typeof props === 'function' ? props().streamMode : props.streamMode,
  );
  const onFinish = createMemo(() =>
    typeof props === 'function' ? props().onFinish : props.onFinish,
  );
  const onResponse = createMemo(() =>
    typeof props === 'function' ? props().onResponse : props.onResponse,
  );
  const onToolCall = createMemo(() =>
    typeof props === 'function' ? props().onToolCall : props.onToolCall,
  );
  const sendExtraMessageFields = createMemo(() =>
    typeof props === 'function'
      ? props().sendExtraMessageFields
      : props.sendExtraMessageFields,
  );
  const experimental_onFunctionCall = createMemo(() =>
    typeof props === 'function'
      ? props().experimental_onFunctionCall
      : props.experimental_onFunctionCall,
  );
  const onError = createMemo(() =>
    typeof props === 'function' ? props().onError : props.onError,
  );
  const maxToolRoundtrips = createMemo(() =>
    typeof props === 'function'
      ? props().maxToolRoundtrips
      : props.maxToolRoundtrips,
  );
  const initialInput = createMemo(() =>
    typeof props === 'function' ? props().initialInput : props.initialInput,
  );

  return {
    id,
    api,
    credentials,
    headers,
    body,
    initialMessages,
    generateId,
    streamMode,
    onFinish,
    onResponse,
    onToolCall,
    sendExtraMessageFields,
    experimental_onFunctionCall,
    onError,
    maxToolRoundtrips,
    initialInput,
  };
}
