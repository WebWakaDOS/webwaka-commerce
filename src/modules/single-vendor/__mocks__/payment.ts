/**
 * Mock payment processor — for tests and development only.
 * MUST NOT be imported from any production code path.
 * Production code uses createPaymentProvider from @webwaka/core.
 */
export async function mockProcessPayment(
  amount: number,
  _email: string,
): Promise<{ success: boolean; reference: string }> {
  const reference = `pay_mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return { success: amount > 0, reference };
}
