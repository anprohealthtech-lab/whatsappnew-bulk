type PhoneRegistration = { platform_type?: string; status?: string };

/** Verify registration even when the popup says Business app onboarding finished. */
export async function completeSignupRegistration(options: {
  phone: PhoneRegistration;
  signupEvent?: string;
  register: () => Promise<unknown>;
  readPhone: () => Promise<PhoneRegistration>;
  steps: Record<string, string>;
}) {
  const { phone, signupEvent, register, readPhone, steps } = options;
  if (signupEvent === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ||
      (phone.platform_type === 'CLOUD_API' && phone.status === 'CONNECTED')) {
    steps.register = 'skipped (already registered by Meta)';
  } else {
    try {
      await register();
      steps.register = 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already|registered/i.test(message)) {
        steps.register = 'already registered';
      } else {
        steps.register = `failed: ${message}`;
        throw error;
      }
    }
  }

  const registeredPhone = await readPhone();
  if (registeredPhone.platform_type !== 'CLOUD_API' || registeredPhone.status !== 'CONNECTED') {
    throw new Error(`Meta has not completed Cloud API registration (platform ${registeredPhone.platform_type || 'unknown'}, status ${registeredPhone.status || 'unknown'}). The app session was not linked. Complete the appropriate onboarding/migration flow and retry.`);
  }
  return registeredPhone;
}
