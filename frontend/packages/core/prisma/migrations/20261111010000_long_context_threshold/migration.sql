-- Long prompts use a second rate card. The *_long rows live in standard_model_prices.
-- Null means the model has one rate however long the prompt is.
ALTER TABLE "standard_models" ADD COLUMN "long_context_threshold" INTEGER;
