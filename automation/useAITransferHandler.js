const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const FormData = require("form-data"); // Add this for audio file uploads

function returnCheck(data) {
  if (data?.assignedToAi && data?.model?.id?.includes("gpt")) {
    return true;
  }
  if (data?.assignedToAi && data?.model?.id?.includes("gemini")) {
    return true;
  }
  return false;
}

const aiTransferHandler = async (inputData, conversationHistory) => {
  const imageAndAudioUnderstand =
    inputData?.knowMedia && returnCheck(inputData);
  const config = { messageReferenceCount: 10, ...inputData };

  const validateInput = (input) => {
    if (!input?.provider?.id || !input?.model?.id || !input?.apiKey) {
      console.error(
        "Validation Error: Missing provider.id, model.id, or apiKey"
      );
      return false;
    }
    return true;
  };

  // Helper function to get local file path from URL
  const getLocalFilePath = (url) => {
    if (!url) return null;
    const urlParts = url.split("/");
    const filename = urlParts[urlParts.length - 1];
    return path.join(__dirname, "../client/public/meta-media", filename);
  };

  // Helper function to read file as base64
  const readFileAsBase64 = (filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return null;
      }
      const fileBuffer = fs.readFileSync(filePath);
      return fileBuffer.toString("base64");
    } catch (error) {
      console.error(`Error reading file: ${error.message}`);
      return null;
    }
  };

  // Helper function to get MIME type from file path
  const getMimeType = (filePath) => {
    return mime.lookup(filePath) || "application/octet-stream";
  };

  // Helper function to transcribe audio using OpenAI's Whisper API
  const transcribeAudioWithOpenAI = async (filePath, apiKey) => {
    try {
      const formData = new FormData();
      formData.append("file", fs.createReadStream(filePath));
      formData.append("model", "whisper-1");

      const response = await axios.post(
        "https://api.openai.com/v1/audio/transcriptions",
        formData,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...formData.getHeaders(),
          },
        }
      );

      return response.data.text;
    } catch (error) {
      console.error(
        "Audio transcription error:",
        error.response?.data || error.message
      );
      return "[Audio transcription failed]";
    }
  };

  const formatConversationHistory = async (history, msgRefCount) => {
    if (!history || !Array.isArray(history)) return [];

    const formattedPromises = history.map(async (msg) => {
      try {
        // Ensure msgContext is parsed correctly, even if it's already an object
        const context =
          typeof msg.msgContext === "string"
            ? JSON.parse(msg.msgContext)
            : msg.msgContext;

        // Handle text messages
        if (msg.type === "text" && context?.text?.body) {
          return {
            role: msg.route === "INCOMING" ? "user" : "assistant",
            content: context.text.body,
          };
        }

        // Handle image messages when knowMedia is true
        else if (
          imageAndAudioUnderstand &&
          msg.type === "image" &&
          context?.image?.link
        ) {
          const imageUrl = context.image.link;
          const caption = context.image.caption || "";
          const localFilePath = getLocalFilePath(imageUrl);

          // For OpenAI format
          if (inputData.provider.id.toLowerCase() === "openai") {
            const content = [];

            // Add caption if available
            if (caption) {
              content.push({ type: "text", text: caption });
            }

            if (localFilePath) {
              const base64Image = readFileAsBase64(localFilePath);
              const mimeType = getMimeType(localFilePath);

              if (base64Image) {
                content.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                  },
                });
              }
            }

            return {
              role: msg.route === "INCOMING" ? "user" : "assistant",
              content:
                content.length > 0 ? content : caption || "Image received",
            };
          }

          // For Gemini format (will be converted later)
          else if (inputData.provider.id.toLowerCase() === "gemini") {
            return {
              role: msg.route === "INCOMING" ? "user" : "assistant",
              content: {
                type: "image",
                localPath: localFilePath,
                caption: caption,
              },
            };
          }

          // For other providers, just use caption as text
          else {
            return {
              role: msg.route === "INCOMING" ? "user" : "assistant",
              content: caption || "Image received",
            };
          }
        }

        // Handle audio messages when knowMedia is true
        else if (
          imageAndAudioUnderstand &&
          msg.type === "audio" &&
          context?.audio?.link
        ) {
          const audioUrl = context.audio.link;
          const localFilePath = getLocalFilePath(audioUrl);

          // For OpenAI, we need to transcribe the audio first using Whisper API
          if (
            inputData.provider.id.toLowerCase() === "openai" &&
            localFilePath
          ) {
            // Transcribe the audio file
            const transcription = await transcribeAudioWithOpenAI(
              localFilePath,
              inputData.apiKey
            );

            return {
              role: msg.route === "INCOMING" ? "user" : "assistant",
              content: transcription
                ? `[Audio transcription]: ${transcription}`
                : "Audio message received but could not be transcribed.",
            };
          }

          // For other providers, just mention audio was received
          else {
            return {
              role: msg.route === "INCOMING" ? "user" : "assistant",
              content: "Audio message received",
            };
          }
        }

        return null;
      } catch (e) {
        console.error("Error parsing msgContext:", msg.msgContext, e);
        return null;
      }
    });

    const formatted = (await Promise.all(formattedPromises)).filter(Boolean);

    if (msgRefCount > 0) {
      return formatted.slice(-msgRefCount);
    }
    return formatted; // Return all formatted messages if msgRefCount is 0 or less
  };

  // --- OpenAI Tool/Function Generation ---
  const generateOpenAITools = (functions) => {
    if (!functions || functions.length === 0) return undefined;
    return functions.map((func) => ({
      type: "function",
      function: {
        name: func.id, // Use the unique ID as the function name for the API
        description: func.name, // Use the descriptive name as the description
        parameters: func.parameters || {
          // Allow passing parameters schema if available
          type: "object",
          properties: {},
          required: [],
        },
      },
    }));
  };

  // --- Gemini Tool/Function Generation ---
  const generateGeminiTools = (functions) => {
    if (!functions || functions.length === 0) return undefined;
    return [
      {
        // Gemini expects a 'tools' array with a single object containing functionDeclarations
        functionDeclarations: functions.map((func) => ({
          name: func.id, // Use the unique ID as the function name for the API
          description: func.name, // Use the descriptive name as the description
          parameters: func.parameters || {
            // Allow passing parameters schema if available
            type: "OBJECT", // Gemini uses uppercase
            properties: {},
            // required: [], // Define if necessary
          },
        })),
      },
    ];
  };

  // --- DeepSeek Function Generation (older OpenAI style) ---
  const generateDeepSeekFunctions = (functions) => {
    if (!functions || functions.length === 0) return undefined;
    return functions.map((func) => ({
      name: func.id, // Use the unique ID as the function name for the API
      description: func.name, // Use the descriptive name as the description
      parameters: func.parameters || {
        type: "object",
        properties: {},
        required: [],
      },
    }));
  };

  const processOpenAI = async (currentInputData, history) => {
    // Prepare messages with system prompt
    const messages = [
      { role: "system", content: currentInputData.systemPrompt },
    ];

    // Process history for OpenAI format
    history.forEach((msg) => {
      if (Array.isArray(msg.content) || typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (msg.content?.type === "image") {
        // Convert Gemini-format image to OpenAI format
        const localPath = msg.content.localPath;
        const caption = msg.content.caption || "Image:";

        if (localPath) {
          const base64Image = readFileAsBase64(localPath);
          const mimeType = getMimeType(localPath);

          if (base64Image) {
            const content = [];
            if (caption) {
              content.push({ type: "text", text: caption });
            }
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            });

            messages.push({
              role: msg.role,
              content: content,
            });
          } else {
            messages.push({ role: msg.role, content: caption });
          }
        } else {
          messages.push({ role: msg.role, content: caption });
        }
      }
    });

    const body = {
      model: currentInputData.model.id,
      messages,
      temperature: currentInputData.temperature,
      max_tokens: currentInputData.maxTokens,
    };

    if (
      currentInputData.aiTask?.active &&
      currentInputData.aiTask.functions?.length > 0
    ) {
      const tools = generateOpenAITools(currentInputData.aiTask.functions);
      if (tools) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
    }

    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        body,
        {
          headers: {
            Authorization: `Bearer ${currentInputData.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const choice = response.data.choices[0].message;
      const result = {
        content: choice.content || "",
        functionCalls: [],
      };

      if (choice.tool_calls) {
        result.functionCalls = choice.tool_calls.map((toolCall) => {
          const originalFunction = currentInputData.aiTask.functions.find(
            (f) => f.id === toolCall.function.name
          );
          return {
            tool_call_id: toolCall.id, // OpenAI specific tool call identifier
            id: originalFunction ? originalFunction.id : toolCall.function.name, // Your function definition ID
            name: originalFunction ? originalFunction.name : "Unknown Function", // Your descriptive function name
            arguments: JSON.parse(toolCall.function.arguments),
          };
        });
      }
      return result;
    } catch (error) {
      console.error("OpenAI API Error:", error.response?.data || error.message);
      const errorMessage =
        error.response?.data?.error?.message ||
        error.message ||
        "OpenAI API request failed";
      return { content: null, functionCalls: [], error: true, errorMessage };
    }
  };

  const processGemini = async (currentInputData, history) => {
    const genAI = new GoogleGenerativeAI(currentInputData.apiKey);
    const geminiTools =
      currentInputData.aiTask?.active &&
      currentInputData.aiTask.functions?.length > 0
        ? generateGeminiTools(currentInputData.aiTask.functions)
        : undefined;

    const modelParams = {
      model: currentInputData.model.id,
      generationConfig: {
        temperature: currentInputData.temperature,
        maxOutputTokens: currentInputData.maxTokens,
      },
      systemInstruction: {
        parts: [{ text: currentInputData.systemPrompt }],
        role: "system",
      },
    };

    if (geminiTools) {
      modelParams.tools = geminiTools;
    }

    const model = genAI.getGenerativeModel(modelParams);

    // Convert history to Gemini format
    const geminiHistory = [];
    for (const msg of history) {
      if (typeof msg.content === "string") {
        geminiHistory.push({
          role: msg.role === "user" ? "user" : "model", // Gemini uses "model" for assistant
          parts: [{ text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        // Handle OpenAI format with multiple content parts
        const parts = [];
        let textContent = "";

        for (const part of msg.content) {
          if (part.type === "text") {
            textContent += part.text + " ";
          } else if (part.type === "image_url" && part.image_url) {
            const dataUrl = part.image_url.url;
            if (dataUrl.startsWith("data:")) {
              const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                parts.push({
                  inlineData: {
                    data: base64Data,
                    mimeType: mimeType,
                  },
                });
              }
            }
          }
        }

        if (textContent) {
          parts.unshift({ text: textContent.trim() });
        }

        geminiHistory.push({
          role: msg.role === "user" ? "user" : "model",
          parts: parts,
        });
      } else if (msg.content?.type === "image") {
        // Handle image content
        const parts = [];
        if (msg.content.caption) {
          parts.push({ text: msg.content.caption });
        }

        if (msg.content.localPath) {
          const base64Image = readFileAsBase64(msg.content.localPath);
          const mimeType = getMimeType(msg.content.localPath);

          if (base64Image) {
            parts.push({
              inlineData: {
                data: base64Image,
                mimeType: mimeType,
              },
            });
          }
        }

        if (parts.length > 0) {
          geminiHistory.push({
            role: msg.role === "user" ? "user" : "model",
            parts: parts,
          });
        }
      }
    }

    // The last message in history is considered the current prompt to the model
    const lastUserMessage =
      geminiHistory.length > 0
        ? geminiHistory[geminiHistory.length - 1].role === "user"
          ? geminiHistory[geminiHistory.length - 1]
          : null
        : null;

    try {
      const chat = model.startChat({
        history: lastUserMessage ? geminiHistory.slice(0, -1) : geminiHistory,
      });

      let response;
      if (lastUserMessage) {
        response = await chat.sendMessage(lastUserMessage.parts);
      } else {
        // If no user message in history, use system prompt
        response = await chat.sendMessage(currentInputData.systemPrompt);
      }

      let textContent = "";
      const calledFunctions = [];
      const fullResponse = response.response;

      if (fullResponse.candidates && fullResponse.candidates.length > 0) {
        const candidate = fullResponse.candidates[0];
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) {
              textContent += part.text;
            }
            if (part.functionCall) {
              const originalFunction = currentInputData.aiTask.functions.find(
                (f) => f.id === part.functionCall.name
              );
              calledFunctions.push({
                id: originalFunction
                  ? originalFunction.id
                  : part.functionCall.name,
                name: originalFunction
                  ? originalFunction.name
                  : "Unknown Function",
                arguments: part.functionCall.args,
              });
            }
          }
        }
      } else {
        textContent = fullResponse.text?.() || ""; // Fallback for simpler text responses
      }

      return {
        content: textContent.trim(),
        functionCalls: calledFunctions,
      };
    } catch (error) {
      console.error("Gemini API Error:", error.message, error.stack);
      const errorMessage = error.message || "Gemini API request failed";
      return { content: null, functionCalls: [], error: true, errorMessage };
    }
  };

  const processDeepSeek = async (currentInputData, history) => {
    const messages = [
      { role: "system", content: currentInputData.systemPrompt },
    ];

    // For DeepSeek, we'll convert any media to text descriptions
    history.forEach((msg) => {
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle OpenAI format with multiple content parts
        let textContent = "";
        let hasImage = false;

        for (const part of msg.content) {
          if (part.type === "text") {
            textContent += part.text + " ";
          } else if (part.type === "image_url") {
            hasImage = true;
          }
        }

        messages.push({
          role: msg.role,
          content: textContent.trim() + (hasImage ? " [Image attached]" : ""),
        });
      } else if (msg.content?.type === "image") {
        messages.push({
          role: msg.role,
          content: (msg.content.caption || "Image:") + " [Image attached]",
        });
      }
    });

    const body = {
      model: currentInputData.model.id,
      messages,
      temperature: currentInputData.temperature,
      max_tokens: currentInputData.maxTokens,
    };

    if (
      currentInputData.aiTask?.active &&
      currentInputData.aiTask.functions?.length > 0
    ) {
      const dsFunctions = generateDeepSeekFunctions(
        currentInputData.aiTask.functions
      );
      if (dsFunctions) {
        body.functions = dsFunctions;
      }
    }

    try {
      const response = await axios.post(
        "https://api.deepseek.com/v1/chat/completions",
        body,
        {
          headers: {
            Authorization: `Bearer ${currentInputData.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const choice = response.data.choices[0].message;
      const result = {
        content: choice.content || "",
        functionCalls: [],
      };

      if (choice.function_call) {
        const originalFunction = currentInputData.aiTask.functions.find(
          (f) => f.id === choice.function_call.name
        );
        result.functionCalls = [
          {
            id: originalFunction
              ? originalFunction.id
              : choice.function_call.name,
            name: originalFunction ? originalFunction.name : "Unknown Function",
            arguments: JSON.parse(choice.function_call.arguments),
          },
        ];
      }
      return result;
    } catch (error) {
      console.error(
        "DeepSeek API Error:",
        error.response?.data || error.message
      );
      const errorMessage =
        error.response?.data?.error?.message ||
        error.message ||
        "DeepSeek API request failed";
      return { content: null, functionCalls: [], error: true, errorMessage };
    }
  };

  // --- Main Handler Logic ---
  if (!validateInput(inputData)) {
    return {
      success: false,
      message: "Invalid input data: Missing provider, model, or API key.",
    };
  }

  // Use messageReferenceCount from inputData if present, otherwise from default config
  const messageCount =
    typeof inputData.messageReferenceCount === "number"
      ? inputData.messageReferenceCount
      : config.messageReferenceCount;

  // Format conversation history with async operations for audio transcription
  const formattedHistory = await formatConversationHistory(
    conversationHistory,
    messageCount
  );

  let result;
  try {
    switch (inputData.provider.id.toLowerCase()) {
      case "openai":
        result = await processOpenAI(inputData, formattedHistory);
        break;
      case "gemini":
        result = await processGemini(inputData, formattedHistory);
        break;
      case "deepseek":
        result = await processDeepSeek(inputData, formattedHistory);
        break;
      default:
        return { success: false, message: "Unsupported AI provider" };
    }

    if (result.error) {
      return {
        success: false,
        message: result.errorMessage || "AI processing failed.",
      };
    }

    return {
      success: true,
      data: {
        message: result.content,
        function:
          result.functionCalls?.length > 0 ? result.functionCalls : null,
      },
    };
  } catch (e) {
    console.error("General aiTransferHandler Error:", e);
    return {
      success: false,
      message: `An unexpected error occurred: ${e.message}`,
    };
  }
};

module.exports = { aiTransferHandler };
