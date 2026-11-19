-- Bedrock regional profiles of Claude 4.5 and later bill 10% over global.
-- Null means the card's rates are used as stored.
ALTER TABLE "standard_models" ADD COLUMN "regional_premium" DECIMAL(4,3);
