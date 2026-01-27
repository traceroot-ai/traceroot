import { NextAuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";
import { compare } from "bcryptjs";
import { Adapter } from "next-auth/adapters";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as Adapter,

  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },

  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET || "",
      allowDangerousEmailAccountLinking: true,
    }),

    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Email and password are required");
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase() },
        });

        if (!user) {
          throw new Error("Invalid credentials");
        }

        if (!user.password) {
          throw new Error(
            "Please sign in with Google (the provider linked to your account)",
          );
        }

        const isValidPassword = await compare(
          credentials.password,
          user.password,
        );

        if (!isValidPassword) {
          throw new Error("Invalid credentials");
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          admin: user.admin,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.admin = user.admin;
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.admin = token.admin as boolean; 
      }
      return session;
    },

    async signIn({ user }) {
      if (!user.email) {
        return false;
      }
      return true;
    },
  },

  pages: {
    signIn: "/auth/sign-in",
    error: "/auth/error",
  },

  secret: process.env.NEXTAUTH_SECRET,
};
