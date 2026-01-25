import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hash } from "bcryptjs";
import { z } from "zod";

const signUpSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const result = signUpSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 },
      );
    }

    const { name, email, password } = result.data;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await prisma.users.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      if (existingUser.password) {
        return NextResponse.json(
          { error: "User already exists. Please sign in." },
          { status: 400 },
        );
      } else {
        return NextResponse.json(
          { error: "Account exists with Google. Please sign in with Google." },
          { status: 400 },
        );
      }
    }

    const hashedPassword = await hash(password, 12);

    await prisma.users.create({
      data: {
        id: crypto.randomUUID(),
        name,
        email: normalizedEmail,
        password: hashedPassword,
        admin: false,
      },
    });

    return NextResponse.json(
      { message: "User created successfully" },
      { status: 201 },
    );
  } catch (error) {
    console.error("Sign-up error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
