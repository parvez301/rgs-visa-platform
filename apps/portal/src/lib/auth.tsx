import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
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
  UserPoolId: import.meta.env.VITE_USERS_POOL_ID ?? "ap-south-1_placeholder",
  ClientId: import.meta.env.VITE_USERS_CLIENT_ID ?? "placeholder",
});

export interface AuthState {
  isLoading: boolean;
  isSignedIn: boolean;
  email: string | null;
  idToken: string | null;
  signUp(email: string, password: string, fullName: string, phone: string): Promise<void>;
  confirmSignUp(email: string, code: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): void;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function cognitoUserFor(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: userPool });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);

  const loadCurrentSession = useCallback(() => {
    const currentUser = userPool.getCurrentUser();
    if (!currentUser) {
      setIsLoading(false);
      return;
    }
    currentUser.getSession((sessionError: Error | null, session: CognitoUserSession | null) => {
      if (!sessionError && session?.isValid()) {
        setEmail(session.getIdToken().payload["email"] ?? null);
        setIdToken(session.getIdToken().getJwtToken());
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
      signUp: (signUpEmail, password, fullName, phone) =>
        new Promise((resolve, reject) => {
          const attributes = [
            new CognitoUserAttribute({ Name: "name", Value: fullName }),
            ...(phone
              ? [new CognitoUserAttribute({ Name: "phone_number", Value: phone })]
              : []),
          ];
          userPool.signUp(signUpEmail, password, attributes, [], (signUpError) =>
            signUpError ? reject(signUpError) : resolve(),
          );
        }),
      confirmSignUp: (confirmEmail, code) =>
        new Promise((resolve, reject) => {
          cognitoUserFor(confirmEmail).confirmRegistration(code, true, (confirmError) =>
            confirmError ? reject(confirmError) : resolve(),
          );
        }),
      signIn: (signInEmail, password) =>
        new Promise((resolve, reject) => {
          const cognitoUser = cognitoUserFor(signInEmail);
          cognitoUser.authenticateUser(
            new AuthenticationDetails({ Username: signInEmail, Password: password }),
            {
              onSuccess: (session) => {
                setEmail(session.getIdToken().payload["email"] ?? signInEmail);
                setIdToken(session.getIdToken().getJwtToken());
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
      },
      forgotPassword: (forgotEmail) =>
        new Promise((resolve, reject) => {
          cognitoUserFor(forgotEmail).forgotPassword({
            onSuccess: () => resolve(),
            onFailure: reject,
            inputVerificationCode: () => resolve(),
          });
        }),
      confirmForgotPassword: (confirmEmail, code, newPassword) =>
        new Promise((resolve, reject) => {
          cognitoUserFor(confirmEmail).confirmPassword(code, newPassword, {
            onSuccess: () => resolve(),
            onFailure: reject,
          });
        }),
    }),
    [isLoading, email, idToken],
  );

  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const authState = useContext(AuthContext);
  if (!authState) throw new Error("useAuth must be used inside AuthProvider");
  return authState;
}
