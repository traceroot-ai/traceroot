import { NextResponse } from "next/server";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import { ReasoningRecordModel } from "@/models/chat";

interface ReasoningData {
  chunk_id: number;
  content: string;
  status: string;
  timestamp: string;
  trace_id?: string;
}

interface ReasoningResponse {
  chat_id: string;
  reasoning: ReasoningData[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chat_id: string }> },
): Promise<NextResponse<ReasoningResponse | null>> {
  try {
    const { chat_id } = await params;

    if (!chat_id) {
      return NextResponse.json(null, { status: 400 });
    }

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return NextResponse.json({
        chat_id,
        reasoning: [],
      });
    }

    try {
      // Connect to MongoDB
      await connectToDatabase();

      // Query reasoning_streams collection
      const reasoningRecords = await ReasoningRecordModel.find({
        chat_id,
      })
        .sort({ chunk_id: 1, timestamp: 1 })
        .lean();

      // Transform the data to match the expected format
      const reasoning: ReasoningData[] = reasoningRecords.map((doc) => ({
        chunk_id: doc.chunk_id,
        content: doc.content,
        status: doc.status,
        timestamp: doc.timestamp.toISOString(),
        trace_id: doc.trace_id,
      }));

      return NextResponse.json({
        chat_id,
        reasoning,
      });
    } catch (dbError) {
      console.error("MongoDB query failed:", dbError);
      // Fall back to empty reasoning response if MongoDB query fails
      return NextResponse.json({
        chat_id,
        reasoning: [],
      });
    }
  } catch (error) {
    console.error("Get Chat Reasoning API Error:", error);
    return NextResponse.json(null, { status: 500 });
  }
}
