import { raw, type RequestHandler } from "express";
export const binaryImport: RequestHandler[] = [
 raw({type:"application/octet-stream",limit:"8mb"}),
 (req,_res,next)=>{
  if(!Buffer.isBuffer(req.body))return next();
  try {
   const encoded=String(req.headers["x-file-name"]||"");
   const fileName=decodeURIComponent(encoded);
   if(!fileName||fileName.length>255||!/^.*\.(csv|xlsx)$/i.test(fileName))throw Object.assign(new Error("Send a CSV/XLSX filename in X-File-Name"),{statusCode:400});
   req.body={fileName,fileBuffer:req.body};next();
  }catch(error){next(error);}
 }
];
