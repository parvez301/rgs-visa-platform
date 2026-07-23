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

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_ADMINS_POOL_ID ?? "ap-south-1_placeholder",
  ClientId: import.meta.env.VITE_ADMINS_CLIENT_ID ?? "placeholder",
});

export interface AuthState {
  isLoading: boolean;
  isSignedIn: boolean;
  email: string | null;
  idToken: string | null;
  needsNewPassword: boolean;
  signIn(email: string, password: string): Promise<"signedIn" | "newPasswordRequired">;
  completeNewPassword(newPassword: string): Promise<void>;
  signOut(): void;
}

const AuthContext = createContext<AuthState | null>(null);

function cognitoUserFor(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: userPool });
}

function applySession(
  session: CognitoUserSession,
  fallbackEmail: string,
  setEmail: (email: string | null) => void,
  setIdToken: (token: string | null) => void,
  setPendingNewPasswordUser: (user: CognitoUser | null) => void,
) {
  setEmail(session.getIdToken().payload["email"] ?? fallbackEmail);
  setIdToken(session.getIdToken().getJwtToken());
  setPendingNewPasswordUser(null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [pendingNewPasswordUser, setPendingNewPasswordUser] = useState<CognitoUser | null>(null);

  const loadCurrentSession = useCallback(() => {
    const currentUser = userPool.getCurrentUser();
    if (!currentUser) {
      setIsLoading(false);
      return;
    }
    currentUser.getSession((sessionError: Error | null, session: CognitoUserSession | null) => {
      if (!sessionError && session?.isValid()) {
        applySession(session, currentUser.getUsername(), setEmail, setIdToken, setPendingNewPasswordUser);
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
      needsNewPassword: pendingNewPasswordUser !== null,
      signIn: (signInEmail, password) =>
        new Promise((resolve, reject) => {
          const cognitoUser = cognitoUserFor(signInEmail);
          cognitoUser.authenticateUser(
            new AuthenticationDetails({ Username: signInEmail, Password: password }),
            {
              onSuccess: (session) => {
                applySession(session, signInEmail, setEmail, setIdToken, setPendingNewPasswordUser);
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
        setPendingNewPasswordUser(null);
      },
    }),
    [isLoading, email, idToken, pendingNewPasswordUser],
  );

  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const authState = useContext(AuthContext);
  if (!authState) throw new Error("useAuth must be used inside AuthProvider");
  return authState;
}
