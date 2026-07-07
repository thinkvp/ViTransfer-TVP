-- AI Assistant: OpenAI (GPT) provider
ALTER TABLE "Settings" ADD COLUMN "aiOpenaiModel" TEXT DEFAULT 'gpt-4o';
ALTER TABLE "Settings" ADD COLUMN "aiOpenaiApiKey" TEXT;

-- Transcription: OpenAI Whisper provider + caption formatting
ALTER TABLE "Settings" ADD COLUMN "transcriptionProvider" TEXT DEFAULT 'LOCAL';
ALTER TABLE "Settings" ADD COLUMN "transcriptionOpenaiApiKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "transcriptionOpenaiModel" TEXT DEFAULT 'whisper-1';
ALTER TABLE "Settings" ADD COLUMN "transcriptionMaxCharsPerLine" INTEGER DEFAULT 42;
ALTER TABLE "Settings" ADD COLUMN "transcriptionMaxLines" INTEGER DEFAULT 2;

-- The previous default model id ('Systran/faster-whisper-large-v3-turbo') does not resolve on
-- Speaches; use a turbo CT2 build that does. Existing rows keep their configured value.
ALTER TABLE "Settings" ALTER COLUMN "transcriptionWhisperModel" SET DEFAULT 'deepdml/faster-whisper-large-v3-turbo-ct2';
