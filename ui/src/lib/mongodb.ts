import mongoose from "mongoose";

// Load MongoDB credentials from environment variables
const DB_USER_NAME = process.env.DB_USER_NAME || "";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "";
const IS_LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

// Construct MongoDB URI from credentials (matching backend pattern)
let MONGODB_URI = "";
if (DB_USER_NAME && DB_PASSWORD && DB_NAME) {
  MONGODB_URI = `mongodb+srv://${DB_USER_NAME}:${DB_PASSWORD}@cluster0.fgwxdgl.mongodb.net/${DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;
}

if (!MONGODB_URI && process.env.NODE_ENV === "production") {
  console.warn(
    "MongoDB credentials (DB_USER_NAME, DB_PASSWORD, DB_NAME) are not defined. Database features will be disabled.",
  );
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var mongoose: MongooseCache | undefined;
}

let cached: MongooseCache = global.mongoose || { conn: null, promise: null };

if (!global.mongoose) {
  global.mongoose = cached;
}

export async function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new Error(
      "MongoDB connection is not available. Please configure DB_USER_NAME, DB_PASSWORD, and DB_NAME.",
    );
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

export function isMongoDBAvailable(): boolean {
  // MongoDB is only available if we have a URI AND we're not in local mode
  return !!MONGODB_URI && !IS_LOCAL_MODE;
}
