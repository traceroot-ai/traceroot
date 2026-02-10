-- CreateIndex
CREATE INDEX "workspaces_stripeCustomerId_idx" ON "workspaces"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "workspaces_stripeSubscriptionId_idx" ON "workspaces"("stripeSubscriptionId");
