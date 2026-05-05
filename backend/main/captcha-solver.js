const { Solver } = require("@2captcha/captcha-solver");

class CaptchaSolver {
  constructor(apiKey) {
    this.solver = new Solver(apiKey);
  }

  async solveRecaptcha(siteKey, pageUrl, options = {}) {
    try {
      console.log("[CAPTCHA] Starting reCAPTCHA solving...");

      const result = await this.solver.recaptcha({
        pageurl: pageUrl,
        googlekey: siteKey,
        ...options,
      });

      console.log("[CAPTCHA] reCAPTCHA solved successfully:", result.id);
      return {
        success: true,
        token: result.data,
        id: result.id,
      };
    } catch (error) {
      console.error("[CAPTCHA] Failed to solve reCAPTCHA:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async reportResult(id, isCorrect) {
    try {
      await this.solver.report(id, isCorrect);
      console.log(
        `[CAPTCHA] Reported result for ${id}: ${isCorrect ? "correct" : "incorrect"}`,
      );
    } catch (error) {
      console.error("[CAPTCHA] Failed to report result:", error.message);
    }
  }
}

module.exports = CaptchaSolver;
