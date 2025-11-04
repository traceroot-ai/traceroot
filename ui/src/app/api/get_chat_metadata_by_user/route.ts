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
        hasMore: false,
      });
    }

    // Get authenticated user
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { history: [], hasMore: false },
        { status: 401 },
      );
    }

    // Parse query parameters for pagination
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "5", 10);
    const skip = parseInt(url.searchParams.get("skip") || "0", 10);

    // Connect to MongoDB
    await connectToDatabase();

    // Get total count for the user
    const totalCount = await ChatMetadataModel.countDocuments({
      user_id: userId,
    });

    // Query chat_metadata collection by user_id with pagination
    const chatMetadataList = await ChatMetadataModel.find({
      user_id: userId,
    })
      .sort({ timestamp: -1 }) // Sort by timestamp descending (newest first)
      .skip(skip)
      .limit(limit)
      .lean();

    // Transform the data to match the expected format
    const history = chatMetadataList.map((item) => ({
      chat_id: item.chat_id,
      timestamp: item.timestamp.getTime(), // Convert Date to milliseconds
      chat_title: item.chat_title,
      trace_id: item.trace_id,
      user_id: item.user_id,
    }));

    // Determine if there are more items to load
    const hasMore = skip + limit < totalCount;

    return NextResponse.json({
      history,
      hasMore,
    });
  } catch (error) {
    console.error("Get Chat Metadata By User API Error:", error);

    const errorResponse: ChatMetadataHistory = {
      history: [],
      hasMore: false,
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
