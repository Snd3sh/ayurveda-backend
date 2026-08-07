import mongoose from "mongoose";

let isConnected = false;

const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = process.env.MONGO_URI;

    if (!mongoURI) {
      throw new Error("MONGO_URI environment variable is not set");
    }

    console.log("🔍 Attempting to connect to MongoDB...");

    const conn = await mongoose.connect(mongoURI, {
      connectTimeoutMS: 15000,
    });

    isConnected = true;
    console.log(`🗄️  MongoDB Connected: ${conn.connection.host}`);
    console.log("✅ Database connection established successfully!");
  } catch (error) {
    isConnected = false;
    console.error("❌ Database connection error:", (error as Error).message);
    throw error;
  }
};

export const getConnectionStatus = (): boolean => isConnected;

export default connectDB;
