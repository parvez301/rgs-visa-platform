import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  primaryRole as selectPrimaryRole,
  type AdminRole,
} from "@rgs/shared";

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_ADMINS_POOL_ID ?? "ap-south-1_placeholder",
  ClientId: import.meta.env.VITE_ADMINS_CLIENT_ID ?? "placeholder",
});

export interface AuthState {
  isLoading: boolean;
  isSignedIn: boolean;
  email: string | null;
  idToken: string | null;
  roles: string[];
  primaryRole: AdminRole | null;
  needsNewPassword: boolean;
  signIn(email: string, password: string): Promise<"signedIn" | "newPasswordRequired">;
  completeNewPassword(newPassword: string): Promise<void>;
  signOut(): void;
}

// Exported so tests that need a real `useAuth()` consumer (rather than a
// `vi.mock` of this whole module) can supply a fixed `AuthState` directly --
// see `apps/admin/test/crm/virtual.ts`'s `renderLedger`.
export const AuthContext = createContext<AuthState | null>(null);

export function parseGroups(groups: unknown): string[] {
  if (groups === undefined || groups === null) return [];

  let parsedGroups: unknown = groups;
  if (typeof groups === "string") {
    try {
      parsedGroups = JSON.parse(groups);
    } catch {
      return [];
    }
  }

  if (
    Array.isArray(parsedGroups) &&
    parsedGroups.every((group) => typeof group === "string")
  ) {
    return parsedGroups;
  }
  return [];
}

function cognitoUserFor(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: userPool });
}

function applySession(
  session: CognitoUserSession,
  fallbackEmail: string,
  setEmail: (email: string | null) => void,
  setIdToken: (token: string | null) => void,
  setRoles: (roles: string[]) => void,
  setPrimaryRole: (role: AdminRole | null) => void,
  setPendingNewPasswordUser: (user: CognitoUser | null) => void,
) {
  const idToken = session.getIdToken();
  const roles = parseGroups(idToken.payload["cognito:groups"]);
  setEmail(idToken.payload["email"] ?? fallbackEmail);
  setIdToken(idToken.getJwtToken());
  setRoles(roles);
  setPrimaryRole(selectPrimaryRole(roles));
  setPendingNewPasswordUser(null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [primaryRole, setPrimaryRole] = useState<AdminRole | null>(null);
  const [pendingNewPasswordUser, setPendingNewPasswordUser] = useState<CognitoUser | null>(null);

  const loadCurrentSession = useCallback(() => {
    const currentUser = userPool.getCurrentUser();
    if (!currentUser) {
      setIsLoading(false);
      return;
    }
    currentUser.getSession((sessionError: Error | null, session: CognitoUserSession | null) => {
      if (!sessionError && session?.isValid()) {
        applySession(
          session,
          currentUser.getUsername(),
          setEmail,
          setIdToken,
          setRoles,
          setPrimaryRole,
          setPendingNewPasswordUser,
        );
      }
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    loadCurrentSession();
  }, [loadCurrentSession]);

  const authState = useMemo<AuthState>(
    () => ({
      isLoading,
      isSignedIn: idToken !== null,
      email,
      idToken,
      roles,
      primaryRole,
      needsNewPassword: pendingNewPasswordUser !== null,
      signIn: (signInEmail, password) =>
        new Promise((resolve, reject) => {
          const cognitoUser = cognitoUserFor(signInEmail);
          cognitoUser.authenticateUser(
            new AuthenticationDetails({ Username: signInEmail, Password: password }),
            {
              onSuccess: (session) => {
                applySession(
                  session,
                  signInEmail,
                  setEmail,
                  setIdToken,
                  setRoles,
                  setPrimaryRole,
                  setPendingNewPasswordUser,
                );
                resolve("signedIn");
              },
              onFailure: reject,
              newPasswordRequired: () => {
                setEmail(signInEmail);
                setPendingNewPasswordUser(cognitoUser);
                resolve("newPasswordRequired");
              },
            },
          );
        }),
      completeNewPassword: (newPassword) =>
        new Promise((resolve, reject) => {
          if (!pendingNewPasswordUser) {
            reject(new Error("No pending password change"));
            return;
          }
          pendingNewPasswordUser.completeNewPasswordChallenge(
            newPassword,
            {},
            {
              onSuccess: (session) => {
                applySession(
                  session,
                  pendingNewPasswordUser.getUsername(),
                  setEmail,
                  setIdToken,
                  setRoles,
                  setPrimaryRole,
                  setPendingNewPasswordUser,
                );
                resolve();
              },
              onFailure: reject,
            },
          );
        }),
      signOut: () => {
        userPool.getCurrentUser()?.signOut();
        setEmail(null);
        setIdToken(null);
        setRoles([]);
        setPrimaryRole(null);
        setPendingNewPasswordUser(null);
      },
    }),
    [isLoading, email, idToken, roles, primaryRole, pendingNewPasswordUser],
  );

  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const authState = useContext(AuthContext);
  if (!authState) throw new Error("useAuth must be used inside AuthProvider");
  return authState;
}
