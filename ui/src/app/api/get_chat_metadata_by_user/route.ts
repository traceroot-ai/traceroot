import { NextResponse } from "next/server";
import { ChatMetadataHistory } from "@/models/chat";
import { auth } from "@clerk/nextjs/server";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import { ChatMetadataModel } from "@/models/chat";

export async function GET(
  request: Request,
): Promise<NextResponse<ChatMetadataHistory>> {
  try {
    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return NextResponse.json({
        history: [],
      });
    }

    // Get authenticated user
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ history: [] }, { status: 401 });
    }

    // Connect to MongoDB
    await connectToDatabase();

    // Query chat_metadata collection by user_id
    const chatMetadataList = await ChatMetadataModel.find({
      user_id: userId,
    })
      .sort({ timestamp: -1 }) // Sort by timestamp descending (newest first)
      .lean();

    // Transform the data to match the expected format
    const history = chatMetadataList.map((item) => ({
      chat_id: item.chat_id,
      timestamp: item.timestamp.getTime(), // Convert Date to milliseconds
      chat_title: item.chat_title,
      trace_id: item.trace_id,
      user_id: item.user_id,
    }));

    return NextResponse.json({
      history,
    });
  } catch (error) {
    console.error("Get Chat Metadata By User API Error:", error);

    const errorResponse: ChatMetadataHistory = {
      history: [],
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
