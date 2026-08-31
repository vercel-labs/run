export interface DemoActor {
  userId: string;
  tenantId: string;
  role: 'tenant-user' | 'approver';
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const requireActor = (
  request: Request,
  role: DemoActor['role'],
): DemoActor => {
  if (request.headers.get('x-demo-role') !== role) {
    throw new HttpError(403, `${role} access is required.`);
  }
  return {
    userId: role === 'approver' ? 'demo_approver' : 'demo_tenant_user',
    tenantId: 'tenant_demo',
    role,
  };
};
