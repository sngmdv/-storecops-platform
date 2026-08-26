"use strict";

/**
 * Onboarding Wizard — guided setup flow for new merchants.
 *
 * Tracks progress through a multi-step onboarding sequence:
 *   1. Welcome & store connection
 *   2. Tracking activation (script tag / snippet)
 *   3. First SEO audit
 *   4. Billing / plan selection
 *   5. Competitor setup
 *   6. First automation
 *   7. Completion & dashboard tour
 *
 * Each step records completion status, timestamps, and can trigger
 * nudge emails if the merchant stalls.
 */

const STEPS = [
  { id: "welcome", title: "Welcome to Storecops", description: "Let's get your store connected." },
  { id: "connect_store", title: "Connect Your Store", description: "Link your Shopify, WooCommerce, or custom store." },
  { id: "activate_tracking", title: "Activate Tracking", description: "Install the tracking snippet to start collecting data." },
  { id: "first_audit", title: "Run Your First Audit", description: "Get a comprehensive health score for your store." },
  { id: "choose_plan", title: "Choose Your Plan", description: "Select the plan that fits your growth goals." },
  { id: "add_competitors", title: "Add Competitors", description: "Track competitor pricing and strategies." },
  { id: "first_automation", title: "Set Up Automation", description: "Configure your first automated campaign." },
  { id: "complete", title: "You're All Set!", description: "Your store is fully configured for growth." },
];

const STEP_WEIGHTS = {
  welcome: 5,
  connect_store: 20,
  activate_tracking: 20,
  first_audit: 15,
  choose_plan: 15,
  add_competitors: 10,
  first_automation: 10,
  complete: 5,
};

function createOnboardingService({ store }) {
  return {
    STEPS,

    /**
     * Get the onboarding state for a store.
     * Creates a fresh state if none exists.
     */
    async getState(store_id) {
      if (!store_id) throw new Error("store_id is required");

      const existing = await store.onboardingStates?.findOne({ store_id });
      if (existing) return existing;

      // Initialize fresh onboarding state.
      const state = {
        store_id,
        current_step: "welcome",
        steps: {},
        started_at: new Date().toISOString(),
        completed: false,
        completion_pct: 0,
      };

      for (const step of STEPS) {
        state.steps[step.id] = {
          completed: false,
          completed_at: null,
          skipped: false,
          data: {},
        };
      }

      if (store.onboardingStates) {
        await store.onboardingStates.insert(state);
      }
      return state;
    },

    /**
     * Mark a step as completed.
     */
    async completeStep(store_id, step_id, data = {}) {
      if (!store_id) throw new Error("store_id is required");
      if (!STEPS.find((s) => s.id === step_id)) throw new Error(`Unknown step: ${step_id}`);

      const state = await this.getState(store_id);
      if (!state.steps[step_id]) throw new Error(`Step not found: ${step_id}`);

      state.steps[step_id].completed = true;
      state.steps[step_id].completed_at = new Date().toISOString();
      state.steps[step_id].data = { ...state.steps[step_id].data, ...data };

      // Advance current_step to the next incomplete step.
      const nextIncomplete = STEPS.find((s) => !state.steps[s.id].completed && !state.steps[s.id].skipped);
      state.current_step = nextIncomplete?.id || "complete";

      // Calculate completion percentage.
      const completedSteps = STEPS.filter((s) => state.steps[s.id].completed).length;
      state.completion_pct = Math.round((completedSteps / STEPS.length) * 100);

      // Check if all steps are done.
      if (completedSteps === STEPS.length) {
        state.completed = true;
        state.completed_at = new Date().toISOString();
      }

      if (store.onboardingStates) {
        const existing = await store.onboardingStates.findOne({ store_id });
        if (existing) {
          await store.onboardingStates.update(existing._id, state);
        } else {
          await store.onboardingStates.insert(state);
        }
      }

      return state;
    },

    /**
     * Skip a step (merchant doesn't want to do it now).
     */
    async skipStep(store_id, step_id) {
      const state = await this.getState(store_id);
      if (!state.steps[step_id]) throw new Error(`Step not found: ${step_id}`);

      state.steps[step_id].skipped = true;
      const nextIncomplete = STEPS.find((s) => !state.steps[s.id].completed && !state.steps[s.id].skipped);
      state.current_step = nextIncomplete?.id || "complete";

      if (store.onboardingStates) {
        const existing = await store.onboardingStates.findOne({ store_id });
        if (existing) {
          await store.onboardingStates.update(existing._id, state);
        }
      }

      return state;
    },

    /**
     * Get the next recommended action for the merchant.
     */
    async getNextAction(store_id) {
      const state = await this.getState(store_id);
      if (state.completed) return { action: "complete", message: "Onboarding is complete!" };

      const currentStep = STEPS.find((s) => s.id === state.current_step);
      if (!currentStep) return { action: "complete", message: "Onboarding is complete!" };

      return {
        action: currentStep.id,
        title: currentStep.title,
        description: currentStep.description,
        step_number: STEPS.indexOf(currentStep) + 1,
        total_steps: STEPS.length,
        completion_pct: state.completion_pct,
      };
    },

    /**
     * Detect stalled onboarding (merchant hasn't progressed in N hours).
     * Returns stores that need a nudge email.
     */
    async detectStalled(hoursThreshold = 24) {
      if (!store.onboardingStates) return [];

      const cutoff = new Date(Date.now() - hoursThreshold * 3600000).toISOString();
      const allStates = await store.onboardingStates.find({});

      return allStates.filter((state) => {
        if (state.completed) return false;
        const lastActivity = state.updatedAt || state.started_at;
        return lastActivity < cutoff;
      });
    },

    /**
     * Get onboarding analytics across all stores.
     */
    async getAnalytics() {
      if (!store.onboardingStates) {
        return { total_stores: 0, completed: 0, in_progress: 0, step_completion: {} };
      }

      const allStates = await store.onboardingStates.find({});
      const stepCompletion = {};

      for (const step of STEPS) {
        stepCompletion[step.id] = {
          title: step.title,
          completed: 0,
          skipped: 0,
          pending: 0,
        };
      }

      let completed = 0;
      let inProgress = 0;

      for (const state of allStates) {
        if (state.completed) completed++;
        else inProgress++;

        for (const step of STEPS) {
          const stepState = state.steps?.[step.id];
          if (stepState?.completed) stepCompletion[step.id].completed++;
          else if (stepState?.skipped) stepCompletion[step.id].skipped++;
          else stepCompletion[step.id].pending++;
        }
      }

      return {
        total_stores: allStates.length,
        completed,
        in_progress: inProgress,
        completion_rate: allStates.length ? Math.round((completed / allStates.length) * 100) : 0,
        step_completion: stepCompletion,
      };
    },
  };
}

module.exports = { createOnboardingService, STEPS };
